// What the workspace header's Create PR button does for a checkout's status, and what it shows
// while a run commits, pushes and opens the pull request.
import type { CreatePullRequestResult, CreatePullRequestRun, GitStatus } from "../../shared/createPullRequest.ts";

export const CREATE_PULL_REQUEST_LABEL = "Create PR";

export type CreatePullRequestButtonState = { readonly kind: "create" } | { readonly kind: "open_pull_request" } | { readonly kind: "disabled"; readonly hint: string };

export type RunningCreatePullRequest = Extract<CreatePullRequestRun, { status: "running" }>;

const NO_ORIGIN = 'Add an "origin" remote before creating a pull request.';

// Why there is nothing to propose from this checkout, or null when a run can create the pull
// request. On the default branch a run commits onto a new feature branch, named from the changes.
function blockedReason(status: GitStatus): string | null {
  if (status.refName === null) return "Create and checkout a ref before pushing or opening a pull request.";
  if (status.hasWorkingTreeChanges) return status.hasUpstream || status.hasPrimaryRemote ? null : NO_ORIGIN;
  if (!status.hasUpstream) {
    if (!status.hasPrimaryRemote) return NO_ORIGIN;
    if (status.aheadCount === 0) return "No local commits to push.";
  } else if (status.aheadCount > 0 && status.behindCount > 0) return "Branch has diverged from upstream. Rebase/merge first.";
  else if (status.behindCount > 0) return "Branch is behind upstream. Pull/rebase before creating a pull request.";
  else if (status.aheadCount === 0 && (status.aheadOfDefaultCount ?? 0) === 0) return "Branch is up to date. No action needed.";
  if (status.isDefaultRef) return `There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on ${status.refName}.`;
  return null;
}

export function resolveCreatePullRequestButton(status: GitStatus | null): CreatePullRequestButtonState {
  if (status === null) return { kind: "disabled", hint: "Git status is unavailable." };
  if (!status.isRepo) return { kind: "disabled", hint: "Not a Git repository." };
  if (status.pr?.state === "open") return { kind: "open_pull_request" };
  // After a squash merge the branch's commits are not on the default branch, so it still looks
  // ahead. A merged or closed pull request with nothing new on the branch leaves nothing to propose.
  if (status.pr && !status.hasWorkingTreeChanges && status.aheadCount === 0) return { kind: "disabled", hint: `Pull request #${status.pr.number} is already ${status.pr.state}.` };
  const hint = blockedReason(status);
  return hint === null ? { kind: "create" } : { kind: "disabled", hint };
}

export function createPullRequestTitle(detail: string | null): string {
  return detail ? `${CREATE_PULL_REQUEST_LABEL} — ${detail}` : CREATE_PULL_REQUEST_LABEL;
}

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
