// GitHub's answers in the panel's contract terms: what a check's state shows as, which actions the
// viewer may take, and the pull request's detail. Each result is validated by its output contract.
import { actionSchema, detailSchema } from "../../shared/pullRequest.ts";
import type { Action, Check, CheckStatus, Detail } from "../../shared/pullRequest.ts";
import type { CheckRunNode, DetailPullRequest, DetailRepository, StatusContextNode } from "./queries.ts";

// A check run reports its conclusion once completed and its status before; a commit status reports
// a state. Values not listed here, such as STALE or one GitHub adds later, show as neutral.
const STATES_BY_STATUS: Record<Exclude<CheckStatus, "neutral">, string[]> = {
  pending: ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "PENDING_DEPLOYMENT"],
  success: ["SUCCESS"],
  failure: ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"],
  "action-required": ["ACTION_REQUIRED"],
  skipped: ["SKIPPED"],
  cancelled: ["CANCELLED"],
};
const STATUS_OF_STATE = new Map(Object.entries(STATES_BY_STATUS).flatMap(([status, states]) => states.map(state => [state, status as CheckStatus])));

// No state yet means it has not run.
export const checkStatus = (state: string | null | undefined): CheckStatus => STATUS_OF_STATE.get((state || "PENDING").toUpperCase()) ?? "neutral";

export function toCheck(node: StatusContextNode | CheckRunNode): Check {
  const required = node.isRequired ?? null;
  if ("context" in node) return { name: node.context, status: checkStatus(node.state), description: node.description ?? null, url: node.targetUrl ?? null, required, workflowName: null };
  return { name: node.name, status: checkStatus(node.conclusion || node.status), description: null, url: node.detailsUrl ?? null, required, workflowName: node.checkSuite?.workflowRun?.workflow?.name ?? null };
}

const PUSH_ACCESS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);
const canPush = (permission: string | null | undefined) => PUSH_ACCESS.has(permission ?? "");
// Merge states in which GitHub merges right away, leaving auto-merge nothing to wait for.
const MERGES_NOW = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const mergesNow = (pr: DetailPullRequest) => pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" && MERGES_NOW.has(pr.mergeStateStatus ?? "");

// The panel offers only what GitHub would let the viewer do; the write itself is still checked by GitHub.
export function allowedActions(repo: DetailRepository, pr: DetailPullRequest): Action[] {
  const granted = new Set<Action>();
  // Merging belongs to the repository's writers.
  if (canPush(repo.viewerPermission)) {
    granted.add("merge").add("disable-auto-merge");
    if (repo.autoMergeAllowed && !mergesNow(pr)) granted.add("enable-auto-merge");
  }
  // State changes belong to anyone who may edit the pull request, its author included.
  if (pr.viewerCanUpdate === true) granted.add("ready").add("draft").add("close").add("reopen");
  // The head branch, when it still exists in this repository, is not the default one, and the viewer can push to it.
  const ownBranch = !pr.isCrossRepository && Boolean(pr.headRef) && pr.headRefName !== repo.defaultBranchRef?.name;
  if (ownBranch && canPush(pr.headRepository?.viewerPermission)) granted.add("delete-branch");
  return actionSchema.options.filter(action => granted.has(action));
}

// GitHub's SCREAMING_CASE enums in the contract's kebab case.
const kebab = (value: string) => value.toLowerCase().replaceAll("_", "-");

export function toDetail(repository: string, repo: DetailRepository, pr: DetailPullRequest): Detail {
  const autoMerge = pr.autoMergeRequest;
  return detailSchema.parse({
    repository, number: pr.number, url: pr.url, title: pr.title, body: pr.body,
    author: pr.author ? { login: pr.author.login } : null,
    state: kebab(pr.state), isDraft: pr.isDraft, mergeability: kebab(pr.mergeable), mergeStateStatus: pr.mergeStateStatus ?? null,
    reviewDecision: pr.reviewDecision ? kebab(pr.reviewDecision) : null,
    additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
    headBranch: pr.headRefName, baseBranch: pr.baseRefName, updatedAt: pr.updatedAt, mergedAt: pr.mergedAt, closedAt: pr.closedAt,
    mergeCapabilities: { merge: repo.mergeCommitAllowed, squash: repo.squashMergeAllowed, rebase: repo.rebaseMergeAllowed },
    autoMergeAllowed: repo.autoMergeAllowed, autoMergeEnabled: Boolean(autoMerge), autoMergeMethod: autoMerge ? kebab(autoMerge.mergeMethod) : null,
    permissions: { actions: allowedActions(repo, pr), editChangeRequest: pr.viewerCanUpdate === true },
  });
}
