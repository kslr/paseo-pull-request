// The Create PR button on the daemon: the checkout's status, with its pull request cached briefly,
// and runs held in memory for the client to poll, one per checkout at a time.
import { resolve } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PaseoApi } from "../paseoApi.ts";
import { startCreatePullRequestRpc } from "../../shared/createPullRequest.ts";
import type { CreatePullRequestRun, GitStatus } from "../../shared/createPullRequest.ts";
import { CommandError, redactError, runCommand } from "../process.ts";
import type { Runner } from "../process.ts";
import { UnavailableError } from "../github.ts";
import { GitRepository } from "./repository.ts";
import { GitMetadataGenerator } from "./metadata.ts";
import { createPullRequest } from "./run.ts";

const KEEP_FINISHED_MS = 600_000;
const PR_CACHE_MS = 15_000;
interface Job { state: CreatePullRequestRun; controller: AbortController; done: Promise<void>; expires: number }
interface PrCache { branch: string; expires: number; value: Promise<GitStatus["pr"]> }

export class CreatePullRequestService {
  readonly runner: Runner;
  private jobs = new Map<string, Job>();
  private active = new Map<string, Job>();
  private prs = new Map<string, PrCache>();
  private closed = false;
  private expiryTimer: ReturnType<typeof setInterval>;
  constructor(runner: Runner = runCommand) {
    this.runner = runner;
    this.expiryTimer = setInterval(() => {
      for (const map of [this.jobs, this.prs]) for (const [key, entry] of map) if (entry.expires <= Date.now()) map.delete(key);
    }, 60_000);
    this.expiryTimer.unref();
  }

  async status({ directory }: { directory: string }): Promise<GitStatus> {
    directory = resolve(directory);
    const repo = new GitRepository(directory, this.runner), { status } = await repo.readStatus();
    const branch = status.isRepo ? status.refName : null;
    if (!branch) return { ...status, pr: null };
    let entry = this.prs.get(directory);
    if (!entry || entry.branch !== branch || entry.expires <= Date.now()) {
      // A checkout without a GitHub remote or gh still has a status, just no pull request.
      const value = repo.github.remote(directory).then(remote => repo.github.branchPullRequest(directory, remote, branch)).catch(error => {
        if (error instanceof UnavailableError || (error instanceof CommandError && error.code !== "ABORT_ERR")) return null;
        throw error;
      });
      const current: PrCache = entry = { branch, expires: Date.now() + PR_CACHE_MS, value };
      this.prs.set(directory, current);
      value.catch(() => { if (this.prs.get(directory) === current) this.prs.delete(directory); });
    }
    return { ...status, pr: await entry.value };
  }

  start(input: RpcInput<typeof startCreatePullRequestRpc>, paseo: PaseoApi): CreatePullRequestRun {
    const directory = resolve(input.directory), key = `${directory}\0${input.runId}`;
    const previous = this.jobs.get(key);
    if (previous && previous.expires > Date.now()) return previous.state;
    if (this.closed) throw new Error("The plugin is stopping.");
    if (this.active.has(directory)) throw new Error("A Git operation is already in progress in this directory.");
    const job: Job = { state: { status: "running", label: "Starting...", lastOutputLine: null, phaseStartedAt: Date.now() }, controller: new AbortController(), done: Promise.resolve(), expires: Infinity };
    this.jobs.set(key, job); this.active.set(directory, job);
    const repo = new GitRepository(directory, this.reporting(job));
    const generator = new GitMetadataGenerator(paseo, input.workspaceId, repo, job.controller.signal);
    const phase = (label: string) => { job.state = { status: "running", label, lastOutputLine: null, phaseStartedAt: Date.now() }; };
    job.done = createPullRequest(repo, generator, phase).then(result => {
      job.state = { status: "succeeded", result };
    }, error => {
      job.state = { status: "failed", message: redactError((error as Error).message) };
    }).finally(() => {
      job.expires = Date.now() + KEEP_FINISHED_MS;
      this.active.delete(directory); this.prs.delete(directory);
    });
    return job.state;
  }
  poll({ directory, runId }: { directory: string; runId: string }): CreatePullRequestRun {
    const job = this.jobs.get(`${resolve(directory)}\0${runId}`);
    if (!job || job.expires <= Date.now()) throw new Error("Git action was not found or has expired.");
    return job.state;
  }

  // The job's runner: cancelled with the job, with a longer time limit, and the output of the steps
  // a user follows (commit hooks, push, PR creation) as progress. The plumbing around them would
  // show paths and hashes.
  private reporting(job: Job): Runner {
    return async (file, args, options) => {
      job.controller.signal.throwIfAborted();
      const reported = file === "gh" ? args[0] === "pr" : args[0] === "commit" || args[0] === "push";
      let streamed = false;
      const onOutputLine = (line: string) => {
        streamed = true;
        if (line.trim() && job.state.status === "running") job.state = { ...job.state, lastOutputLine: redactError(line.trim()) };
      };
      const result = await this.runner(file, args, { ...options, timeout: options.timeout ?? 10 * 60_000, signal: job.controller.signal, ...(reported ? { onOutputLine } : {}) });
      // Injected runners can return buffered output without emitting lines.
      if (reported && !streamed) for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) onOutputLine(line);
      return result;
    };
  }

  async cleanup() {
    this.closed = true; clearInterval(this.expiryTimer);
    for (const job of this.active.values()) job.controller.abort();
    await Promise.all([...this.active.values()].map(job => job.done));
    this.jobs.clear(); this.prs.clear();
  }
}
