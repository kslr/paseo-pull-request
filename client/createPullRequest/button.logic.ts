// What the workspace header's Create PR button does for a checkout's status, and what it shows
// while a run commits, pushes and opens the pull request.
import type { CreatePullRequestResult, CreatePullRequestRun, GitStatus } from "../../shared/createPullRequest.ts";

export const CREATE_PULL_REQUEST_LABEL = "Create PR";

export type CreatePullRequestButtonState = { readonly kind: "create" } | { readonly kind: "open_pull_request" } | { readonly kind: "disabled"; readonly hint: string };

export type RunningCreatePullRequest = Extract<CreatePullRequestRun, { status: "running" }>;

const HINTS = {
  unavailable: "Git status is unavailable.",
  notRepository: "Not a Git repository.",
  detached: "Create and checkout a ref before pushing or opening a pull request.",
  noOrigin: 'Add an "origin" remote before creating a pull request.',
  nothingToPush: "No local commits to push.",
  diverged: "Branch has diverged from upstream. Rebase/merge first.",
  behind: "Branch is behind upstream. Pull/rebase before creating a pull request.",
  upToDate: "Branch is up to date. No action needed.",
} as const;

// With nothing to commit, a run only pushes the commits already on the branch: is there anything
// to push and propose, and can it be pushed as it is?
function committedWorkProblem(status: GitStatus): string | null {
  if (!status.hasUpstream) {
    if (!status.hasPrimaryRemote) return HINTS.noOrigin;
    return status.aheadCount === 0 ? HINTS.nothingToPush : null;
  }
  if (status.behindCount > 0) return status.aheadCount > 0 ? HINTS.diverged : HINTS.behind;
  // Pushed already, but the commits are still not on the default branch: that is a pull request.
  return status.aheadCount === 0 && !status.aheadOfDefaultCount ? HINTS.upToDate : null;
}

// Why a run cannot propose anything from this checkout, or null when it can. Uncommitted changes
// are committed by the run, onto a feature branch named from them when on the default branch.
function blockedReason(status: GitStatus & { refName: string }): string | null {
  if (status.hasWorkingTreeChanges) return status.hasUpstream || status.hasPrimaryRemote ? null : HINTS.noOrigin;
  const problem = committedWorkProblem(status);
  if (problem !== null) return problem;
  // A pull request from the default branch into itself cannot exist, and without changes there is
  // nothing to name a feature branch from.
  return status.isDefaultRef ? `There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on ${status.refName}.` : null;
}

const disabled = (hint: string): CreatePullRequestButtonState => ({ kind: "disabled", hint });

export function resolveCreatePullRequestButton(status: GitStatus | null): CreatePullRequestButtonState {
  if (status === null) return disabled(HINTS.unavailable);
  if (!status.isRepo) return disabled(HINTS.notRepository);
  const { pr, refName } = status;
  if (pr?.state === "open") return { kind: "open_pull_request" };
  // A squash-merged branch's commits never reach the default branch, so it keeps looking ahead.
  // Unless something was added since, a merged or closed pull request leaves nothing to propose.
  if (pr && !status.hasWorkingTreeChanges && status.aheadCount === 0) return disabled(`Pull request #${pr.number} is already ${pr.state}.`);
  if (refName === null) return disabled(HINTS.detached);
  const hint = blockedReason({ ...status, refName });
  return hint === null ? { kind: "create" } : disabled(hint);
}

export function createPullRequestTitle(detail: string | null): string {
  return detail ? `${CREATE_PULL_REQUEST_LABEL} — ${detail}` : CREATE_PULL_REQUEST_LABEL;
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
export function createPullRequestToast({ pr }: CreatePullRequestResult): string {
  const title = pr.title.length <= 72 ? pr.title : `${pr.title.slice(0, 69).trimEnd()}...`;
  return `${pr.status === "created" ? "Created" : "Opened"} PR #${pr.number}: ${title}`;
}
