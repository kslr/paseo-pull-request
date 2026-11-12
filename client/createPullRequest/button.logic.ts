// What the workspace header's button does for a checkout's status, and what it shows while a run
// commits, pushes and, off the default branch, opens the pull request.
import type { CreatePullRequestAction, CreatePullRequestResult, CreatePullRequestRun, GitStatus } from "../../shared/createPullRequest.ts";

export const CREATE_PULL_REQUEST_LABEL = "Create PR";

// Work on the default branch is pushed to it; work on any other branch, such as a worktree's,
// becomes that branch's pull request. Neither creates or switches branches.
export type CreatePullRequestButtonState =
  | { readonly kind: "run"; readonly action: CreatePullRequestAction }
  | { readonly kind: "open_pull_request" }
  | { readonly kind: "disabled"; readonly hint: string };

export type RunningCreatePullRequest = Extract<CreatePullRequestRun, { status: "running" }>;

export function resolveCreatePullRequestButton(status: GitStatus | null): CreatePullRequestButtonState {
  if (status?.pr?.state === "open") return { kind: "open_pull_request" };
  const hint = blockedReason(status);
  if (hint !== null) return { kind: "disabled", hint };
  // blockedReason has a hint for a missing status.
  return { kind: "run", action: status!.isDefaultRef ? "commit_push" : "commit_push_pr" };
}

// Why a run can do nothing for this checkout, or null when it can.
function blockedReason(status: GitStatus | null): string | null {
  if (status === null) return "Git status is unavailable.";
  if (!status.isRepo) return "Not a Git repository.";
  const { pr, refName, isDefaultRef } = status;
  const goal = isDefaultRef ? "pushing" : "creating a pull request";
  if (refName === null) return "Create and checkout a ref before pushing or opening a pull request.";
  if (!isDefaultRef) {
    // A squash-merged branch's commits never reach the default branch, so it keeps looking ahead.
    // Unless something was added since, a merged or closed pull request leaves nothing to propose.
    if (pr && !status.hasWorkingTreeChanges && status.aheadCount === 0) return `Pull request #${pr.number} is already ${pr.state}.`;
    if (!status.hasGitHubRemote) return "Add a GitHub remote before creating a pull request.";
  }
  // Behind upstream, the push would be refused, after committing.
  if (status.hasUpstream && status.behindCount > 0) {
    return status.aheadCount > 0 ? "Branch has diverged from upstream. Rebase/merge first." : `Branch is behind upstream. Pull/rebase before ${goal}.`;
  }
  // Uncommitted changes are committed by the run.
  if (status.hasWorkingTreeChanges) return null;
  // Otherwise the run only pushes the commits already on the branch: is there anything to push
  // or propose?
  if (!status.hasUpstream) {
    if (status.aheadCount === 0) return "No local commits to push.";
  } else if (status.aheadCount === 0 && (isDefaultRef || !status.aheadOfDefaultCount)) {
    // Pushed already, but commits still not on the default branch are a pull request.
    return "Branch is up to date. No action needed.";
  }
  return null;
}

// The header button's label, Lucide icon and tooltip: Commit & push, or Push, on the default
// branch, and Create PR elsewhere.
export interface ButtonFace { readonly label: string; readonly icon: "GitPullRequest" | "Upload"; readonly title: string }
export function resolveButtonFace(status: GitStatus | null, state: CreatePullRequestButtonState): ButtonFace {
  const hint = state.kind === "disabled" ? state.hint : null;
  if (!status?.isDefaultRef) return { label: CREATE_PULL_REQUEST_LABEL, icon: "GitPullRequest", title: createPullRequestTitle(hint) };
  const label = status.hasWorkingTreeChanges ? "Commit & push" : "Push";
  return { label, icon: "Upload", title: hint === null ? `${label} to ${status.refName}` : createPullRequestTitle(hint, label) };
}

export function createPullRequestTitle(detail: string | null, label = CREATE_PULL_REQUEST_LABEL): string {
  return detail ? `${label} — ${detail}` : label;
}

// "42s", then "1m 10s".
function formatElapsed(startedAtMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000)), minutes = Math.floor(total / 60);
  return minutes === 0 ? `${total}s` : `${minutes}m ${total - minutes * 60}s`;
}

// The button's label while a run is in progress: the daemon's progress and the step's elapsed time.
// `run` is null until the daemon has answered the start request.
export function resolveCreatePullRequestProgress(run: RunningCreatePullRequest | null, nowMs: number): { readonly label: string; readonly output: string | null } {
  if (run === null) return { label: "Starting...", output: null };
  return { label: `${run.label} ${formatElapsed(run.phaseStartedAt, nowMs)}`, output: run.lastOutputLine?.trim() || null };
}

// Paseo's toast is one line.
const oneLine = (text: string) => (text.length <= 72 ? text : `${text.slice(0, 69).trimEnd()}...`);
export function createPullRequestToast({ commit, pr }: CreatePullRequestResult): string {
  if (pr === null) return commit ? `Committed and pushed: ${oneLine(commit.subject)}` : "Pushed";
  return `${pr.status === "created" ? "Created" : "Opened"} PR #${pr.number}: ${oneLine(pr.title)}`;
}
