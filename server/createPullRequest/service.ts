// The Create PR button on the daemon: the checkout's status, with its branch's pull request looked
// up behind a short cache, and runs held in memory for the client to poll, one per checkout at a time.
import { resolve } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PaseoApi } from "../paseoApi.ts";
import type { CreatePullRequestRun, GitStatus, startCreatePullRequestRpc } from "../../shared/createPullRequest.ts";
import { commandFailed, redactError, runCommand } from "../process.ts";
import type { Runner } from "../process.ts";
import { UnavailableError } from "../github.ts";
import { ReadCache } from "../readCache.ts";
import { GitRepository } from "./repository.ts";
import { GitMetadataGenerator } from "./metadata.ts";
import { createPullRequest } from "./run.ts";

const KEEP_FINISHED_MS = 600_000;
const PR_CACHE_MS = 15_000;
const SWEEP_MS = 60_000;
// Commit hooks and generation can take minutes.
const STEP_TIMEOUT_MS = 10 * 60_000;

interface Job { state: CreatePullRequestRun; controller: AbortController; done: Promise<void>; expires: number }

const runKey = (directory: string, runId: string) => `${directory}\0${runId}`;
const running = (label: string): CreatePullRequestRun => ({ status: "running", label, lastOutputLine: null, phaseStartedAt: Date.now() });
// The steps a user follows as they run: commit hooks, the push, creating the pull request. The
// plumbing around them would only show paths and hashes. A git command may lead with -c settings.
const isReported = (file: string, args: string[]) => {
  if (file === "gh") return args[0] === "pr";
  const command = args.find((arg, index) => arg !== "-c" && args[index - 1] !== "-c");
  return command === "commit" || command === "push";
};
// No GitHub remote, gh missing or signed out, offline: the checkout still has a status, without a
// pull request. A cancelled lookup is not one of these.
const withoutPullRequest = (error: unknown) => error instanceof UnavailableError || commandFailed(error);

export class CreatePullRequestService {
  readonly runner: Runner;
  private runs = new Map<string, Job>();
  // The run in progress in each checkout.
  private busy = new Map<string, Job>();
  // Each checkout's branch pull requests.
  private lookups = new ReadCache();
  private closed = false;
  private sweeper: ReturnType<typeof setInterval>;
  constructor(runner: Runner = runCommand) {
    this.runner = runner;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, { expires }] of this.runs) if (expires <= now) this.runs.delete(key);
    }, SWEEP_MS);
    this.sweeper.unref();
  }

  async status({ directory }: { directory: string }): Promise<GitStatus> {
    const repo = new GitRepository(resolve(directory), this.runner), { status } = await repo.readStatus();
    const branch = status.isRepo ? status.refName : null;
    return { ...status, pr: branch ? await this.branchPullRequest(repo, branch) : null };
  }

  start(input: RpcInput<typeof startCreatePullRequestRpc>, paseo: PaseoApi): CreatePullRequestRun {
    const directory = resolve(input.directory), key = runKey(directory, input.runId);
    // Starting the same run again, e.g. on a retried request, answers with the run.
    const existing = this.live(key);
    if (existing) return existing.state;
    if (this.closed) throw new Error("The plugin is stopping.");
    if (this.busy.has(directory)) throw new Error("A Git operation is already in progress in this directory.");
    const job: Job = { state: running("Starting..."), controller: new AbortController(), done: Promise.resolve(), expires: Infinity };
    this.runs.set(key, job);
    this.busy.set(directory, job);
    const repo = new GitRepository(directory, this.reportingRunner(job));
    const generator = new GitMetadataGenerator(paseo, input.workspaceId, repo, job.controller.signal);
    job.done = createPullRequest(repo, generator, label => { job.state = running(label); }).then(
      (result): CreatePullRequestRun => ({ status: "succeeded", result }),
      (error): CreatePullRequestRun => ({ status: "failed", message: redactError((error as Error).message) }),
    ).then(state => {
      job.state = state;
      job.expires = Date.now() + KEEP_FINISHED_MS;
      // The run may have pushed or opened a pull request: the next status looks again.
      this.busy.delete(directory);
      this.lookups.drop(directory);
    });
    return job.state;
  }
  poll({ directory, runId }: { directory: string; runId: string }): CreatePullRequestRun {
    const job = this.live(runKey(resolve(directory), runId));
    if (!job) throw new Error("Git action was not found or has expired.");
    return job.state;
  }

  async cleanup() {
    this.closed = true;
    clearInterval(this.sweeper);
    const active = [...this.busy.values()];
    for (const job of active) job.controller.abort();
    await Promise.all(active.map(job => job.done));
    this.runs.clear();
  }

  private live(key: string) {
    const job = this.runs.get(key);
    return job && job.expires > Date.now() ? job : undefined;
  }
  private branchPullRequest({ directory, github }: GitRepository, branch: string): Promise<GitStatus["pr"]> {
    return this.lookups.read(directory, branch, PR_CACHE_MS, () => github.remote().then(remote => github.branchPullRequest(remote, branch)).catch(error => {
      if (withoutPullRequest(error)) return null;
      throw error;
    }));
  }
  // A job's commands: cancelled with it, with a longer time limit, and the reported steps' output
  // shown as its progress.
  private reportingRunner(job: Job): Runner {
    const onOutputLine = (line: string) => {
      if (job.state.status === "running") job.state = { ...job.state, lastOutputLine: redactError(line.trim()) };
    };
    return (file, args, options) => {
      job.controller.signal.throwIfAborted();
      return this.runner(file, args, { ...options, timeout: options.timeout ?? STEP_TIMEOUT_MS, signal: job.controller.signal, ...(isReported(file, args) ? { onOutputLine } : {}) });
    };
  }
}
