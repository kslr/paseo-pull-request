// The pull request panel on the daemon: finds the pull request of the workspace's branch, reads it from GitHub
// behind a short cache, and runs its state changes. Untrusted GitHub JSON is shaped here and
// validated by each output contract; no raw object escapes an RPC.
import type { RpcInput } from "@getpaseo/plugin";
import * as c from "../../shared/pullRequest.ts";
import type { Action, ActionInput, Check, CheckStatus, Detail, PrRef, ResolveResult } from "../../shared/pullRequest.ts";
import { GitHub, UnavailableError } from "../github.ts";
import { redactError } from "../process.ts";
import * as q from "./queries.ts";

type Raw = Record<string, any>;
const ok = { ok: true as const };

// GitHub's CheckRun conclusion or status, or StatusContext state; anything else is neutral.
const CHECK_STATUSES: Record<string, CheckStatus> = {
  SUCCESS: "success", FAILURE: "failure", ERROR: "failure", TIMED_OUT: "failure", STARTUP_FAILURE: "failure",
  ACTION_REQUIRED: "action-required", SKIPPED: "skipped", NEUTRAL: "neutral", CANCELLED: "cancelled",
  PENDING: "pending", EXPECTED: "pending", QUEUED: "pending", IN_PROGRESS: "pending", WAITING: "pending", REQUESTED: "pending", PENDING_DEPLOYMENT: "pending",
};
const canWrite = (permission: string | null | undefined) => ["WRITE", "MAINTAIN", "ADMIN"].includes(permission ?? "");
const STATE_MUTATIONS = { "disable-auto-merge": "disablePullRequestAutoMerge", ready: "markPullRequestReadyForReview", draft: "convertPullRequestToDraft", close: "closePullRequest", reopen: "reopenPullRequest" } as const;

export class PullRequestService {
  private cache = new Map<string, { expires: number; value: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  readonly github: GitHub;
  constructor(github = new GitHub()) { this.github = github; }

  private async host(ref: PrRef) { return (await this.github.remote(ref.directory)).host; }
  private async query(ref: PrRef, query: string, extra: Record<string, unknown> = {}): Promise<Raw> {
    const [owner, name] = ref.repository.split("/");
    const data = await this.github.graphql(ref.directory, await this.host(ref), query, { owner, name, number: ref.number, ...extra });
    if (!data.repository?.pullRequest) throw new Error(`Pull request #${ref.number} was not found in ${ref.repository}.`);
    return data.repository;
  }
  private async mutate(ref: PrRef, field: string, input: Record<string, unknown>) {
    const type = `${field[0].toUpperCase()}${field.slice(1)}Input`;
    await this.github.graphql(ref.directory, await this.host(ref), `mutation($input:${type}!) { ${field}(input:$input) { clientMutationId } }`, { input });
    await this.refresh(ref);
  }
  // Reads are cached per pull request, shared by every workspace showing it.
  private async key(ref: PrRef) { return `${await this.host(ref)}/${ref.repository}#${ref.number}:`; }
  private async cached<T>(ref: PrRef, name: string, ttl: number, read: () => Promise<T>): Promise<T> {
    const key = `${await this.key(ref)}${name}`;
    const entry = this.cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.value as T;
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<T>;
    const task = read().then(value => {
      if (this.pending.get(key) === task) this.cache.set(key, { expires: Date.now() + ttl, value });
      return value;
    }).finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
    this.pending.set(key, task);
    return task;
  }
  async refresh(ref: PrRef) {
    const prefix = await this.key(ref);
    for (const map of [this.cache, this.pending]) for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    return ok;
  }

  async resolve({ directory }: { directory: string }): Promise<ResolveResult> {
    try {
      const remote = await this.github.remote(directory);
      await this.github.auth(directory, remote.host);
      const head = (await this.github.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory })).stdout.trim();
      const branch = head === "HEAD" ? null : head;
      const pr = branch ? await this.github.branchPullRequest(directory, remote, branch) : null;
      return pr ? { status: "found", repository: remote.repository, number: pr.number } : { status: "none", repository: remote.repository, branch };
    } catch (error) {
      return { status: "unavailable", reason: error instanceof UnavailableError ? error.reason : "error", message: redactError((error as Error).message) };
    }
  }
  async checks(ref: PrRef) {
    return this.cached(ref, "checks", 10_000, async () => {
      const checks: Check[] = [];
      let after: string | null = null;
      do {
        const contexts: Raw | undefined = (await this.query(ref, q.checksQuery, { after })).pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
        if (!contexts) break;
        checks.push(...contexts.nodes.map((v: Raw) => ({
          name: v.name ?? v.context, status: CHECK_STATUSES[(v.conclusion || v.status || v.state || "PENDING").toUpperCase()] ?? "neutral",
          description: v.description ?? null, url: v.detailsUrl ?? v.targetUrl ?? null, required: v.isRequired ?? null, workflowName: v.checkSuite?.workflowRun?.workflow?.name ?? null,
        })));
        after = contexts.pageInfo.hasNextPage ? contexts.pageInfo.endCursor : null;
      } while (after);
      return c.checksRpc.output.parse({ checks });
    });
  }
  async detail(ref: PrRef): Promise<Detail> {
    return this.cached(ref, "detail", 30_000, async () => {
      const repo = await this.query(ref, q.detailQuery), pr = repo.pullRequest;
      const write = canWrite(repo.viewerPermission), update = pr.viewerCanUpdate === true;
      const canMergeNow = pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeStateStatus);
      const allowed: Record<Action, boolean> = {
        merge: write, "enable-auto-merge": write && repo.autoMergeAllowed && !canMergeNow, "disable-auto-merge": write,
        ready: update, draft: update, close: update, reopen: update,
        "delete-branch": !pr.isCrossRepository && !!pr.headRef && pr.headRefName !== repo.defaultBranchRef?.name && canWrite(pr.headRepository?.viewerPermission),
      };
      return c.detailSchema.parse({
        repository: ref.repository, number: pr.number, url: pr.url, title: pr.title, body: pr.body, author: pr.author ? { login: pr.author.login } : null,
        state: pr.state.toLowerCase(), isDraft: pr.isDraft, mergeability: pr.mergeable.toLowerCase(), mergeStateStatus: pr.mergeStateStatus ?? null,
        reviewDecision: pr.reviewDecision?.toLowerCase().replaceAll("_", "-") ?? null,
        additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles, headBranch: pr.headRefName, baseBranch: pr.baseRefName,
        updatedAt: pr.updatedAt, mergedAt: pr.mergedAt, closedAt: pr.closedAt,
        mergeCapabilities: { merge: repo.mergeCommitAllowed, squash: repo.squashMergeAllowed, rebase: repo.rebaseMergeAllowed },
        autoMergeAllowed: repo.autoMergeAllowed, autoMergeEnabled: !!pr.autoMergeRequest, autoMergeMethod: pr.autoMergeRequest?.mergeMethod.toLowerCase() ?? null,
        permissions: { actions: c.actionSchema.options.filter(action => allowed[action]), editChangeRequest: update },
      });
    });
  }

  async action(input: ActionInput) {
    const repo = await this.query(input, q.writeStateQuery), pr = repo.pullRequest;
    if (input.action === "merge" || input.action === "enable-auto-merge") {
      // A merge queue only takes merges through auto-merge. A direct merge pins the reviewed head.
      const auto = input.action === "enable-auto-merge" || pr.isMergeQueueEnabled === true;
      await this.mutate(input, auto ? "enablePullRequestAutoMerge" : "mergePullRequest", { pullRequestId: pr.id, mergeMethod: input.mergeMethod.toUpperCase(), ...(auto ? {} : { expectedHeadOid: pr.headRefOid }) });
    } else if (input.action === "delete-branch") {
      if (pr.isCrossRepository) throw new Error("Branches from fork pull requests cannot be deleted here.");
      if (pr.state === "OPEN") throw new Error("Close or merge the pull request before deleting its branch.");
      if (pr.headRefName === repo.defaultBranchRef?.name) throw new Error("The repository's default branch cannot be deleted.");
      if (!pr.headRef) throw new Error("The pull request branch no longer exists.");
      if (pr.headRef.target.oid !== pr.headRefOid) throw new Error("The branch has new commits since this pull request. It cannot be deleted here.");
      await this.mutate(input, "updateRefs", { repositoryId: repo.id, refUpdates: [{ name: `refs/heads/${pr.headRefName}`, beforeOid: pr.headRef.target.oid, afterOid: "0".repeat(40) }] });
    } else await this.mutate(input, STATE_MUTATIONS[input.action], { pullRequestId: pr.id });
    return ok;
  }
  async update({ title, body, ...ref }: RpcInput<typeof c.updateRpc>) {
    const { pullRequest } = await this.query(ref, q.writeStateQuery);
    await this.mutate(ref, "updatePullRequest", { pullRequestId: pullRequest.id, title, body });
    return ok;
  }
}
