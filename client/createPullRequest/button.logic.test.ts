import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitStatus } from "../../shared/createPullRequest.ts";
import {
  createPullRequestTitle,
  createPullRequestToast,
  resolveButtonFace,
  resolveCreatePullRequestButton,
  resolveCreatePullRequestProgress,
  type RunningCreatePullRequest,
} from "./button.logic.ts";

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    hasGitHubRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
    ...overrides,
  };
}

const openPr = { number: 7, title: "Open PR", url: "https://github.com/o/r/pull/7", state: "open" } as const;
const create = { kind: "run", action: "commit_push_pr" } as const;
const push = { kind: "run", action: "commit_push" } as const;

describe("resolveCreatePullRequestButton", () => {
  it("creates a pull request from a feature branch with changes or commits to propose", () => {
    assert.deepEqual(resolveCreatePullRequestButton(status({ hasWorkingTreeChanges: true })), create);
    assert.deepEqual(resolveCreatePullRequestButton(status({ hasUpstream: false, aheadCount: 2 })), create);
    assert.deepEqual(resolveCreatePullRequestButton(status({ aheadOfDefaultCount: 1 })), create);
  });

  it("commits and pushes on the default branch, without creating or switching branches", () => {
    const main = { refName: "main", isDefaultRef: true };
    assert.deepEqual(resolveCreatePullRequestButton(status({ ...main, hasWorkingTreeChanges: true })), push);
    assert.deepEqual(resolveCreatePullRequestButton(status({ ...main, hasWorkingTreeChanges: true, hasUpstream: false })), push);
    assert.deepEqual(resolveCreatePullRequestButton(status({ ...main, aheadCount: 1 })), push);
    // Pushing needs no GitHub remote.
    assert.deepEqual(resolveCreatePullRequestButton(status({ ...main, hasWorkingTreeChanges: true, hasGitHubRemote: false })), push);
    assert.deepEqual(resolveCreatePullRequestButton(status({ ...main })), { kind: "disabled", hint: "Branch is up to date. No action needed." });
    // Behind upstream, a commit could not be pushed.
    for (const fields of [{ behindCount: 1 }, { behindCount: 1, hasWorkingTreeChanges: true }]) {
      assert.deepEqual(resolveCreatePullRequestButton(status({ ...main, ...fields })), { kind: "disabled", hint: "Branch is behind upstream. Pull/rebase before pushing." });
    }
  });

  it("is Commit & push or Push on the default branch and Create PR elsewhere", () => {
    const face = (fields: Partial<GitStatus>) => { const s = status(fields); return resolveButtonFace(s, resolveCreatePullRequestButton(s)); };
    assert.deepEqual(face({ refName: "main", isDefaultRef: true, hasWorkingTreeChanges: true }), { label: "Commit & push", icon: "Upload", title: "Commit & push to main" });
    assert.deepEqual(face({ refName: "main", isDefaultRef: true, aheadCount: 1 }), { label: "Push", icon: "Upload", title: "Push to main" });
    assert.deepEqual(face({ refName: "main", isDefaultRef: true }), { label: "Push", icon: "Upload", title: "Push — Branch is up to date. No action needed." });
    assert.deepEqual(face({ hasWorkingTreeChanges: true }), { label: "Create PR", icon: "GitPullRequest", title: "Create PR" });
    assert.deepEqual(face({ hasUpstream: false }), { label: "Create PR", icon: "GitPullRequest", title: "Create PR — No local commits to push." });
  });

  it("opens the panel when the branch already has an open pull request", () => {
    assert.deepEqual(resolveCreatePullRequestButton(status({ pr: openPr, hasWorkingTreeChanges: true })), { kind: "open_pull_request" });
    assert.deepEqual(resolveCreatePullRequestButton(status({ pr: openPr })), { kind: "open_pull_request" });
  });

  it("does not offer a duplicate of a merged or closed pull request", () => {
    const merged = { ...openPr, state: "merged" } as const;
    assert.deepEqual(resolveCreatePullRequestButton(status({ pr: merged, aheadOfDefaultCount: 3 })), { kind: "disabled", hint: "Pull request #7 is already merged." });
    assert.deepEqual(resolveCreatePullRequestButton(status({ pr: { ...openPr, state: "closed" }, aheadOfDefaultCount: 3 })), { kind: "disabled", hint: "Pull request #7 is already closed." });
    // New work on the branch is a new pull request.
    assert.deepEqual(resolveCreatePullRequestButton(status({ pr: merged, hasWorkingTreeChanges: true })), create);
    assert.deepEqual(resolveCreatePullRequestButton(status({ pr: merged, aheadCount: 1, aheadOfDefaultCount: 4 })), create);
  });

  it("is disabled with the hint otherwise", () => {
    assert.deepEqual(resolveCreatePullRequestButton(null), { kind: "disabled", hint: "Git status is unavailable." });
    assert.deepEqual(resolveCreatePullRequestButton(status()), { kind: "disabled", hint: "Branch is up to date. No action needed." });
    assert.deepEqual(resolveCreatePullRequestButton(status({ refName: null })), { kind: "disabled", hint: "Create and checkout a ref before pushing or opening a pull request." });
    assert.deepEqual(resolveCreatePullRequestButton(status({ aheadCount: 1, behindCount: 1 })), { kind: "disabled", hint: "Branch has diverged from upstream. Rebase/merge first." });
    assert.deepEqual(resolveCreatePullRequestButton(status({ hasUpstream: false })), { kind: "disabled", hint: "No local commits to push." });
    assert.deepEqual(resolveCreatePullRequestButton(status({ pr: { ...openPr, state: "merged" } })), { kind: "disabled", hint: "Pull request #7 is already merged." });
  });

  it("says what to do first when the branch cannot be proposed as it is", () => {
    assert.deepEqual(resolveCreatePullRequestButton(status({ behindCount: 2 })), { kind: "disabled", hint: "Branch is behind upstream. Pull/rebase before creating a pull request." });
    const noGitHub = { kind: "disabled", hint: "Add a GitHub remote before creating a pull request." } as const;
    assert.deepEqual(resolveCreatePullRequestButton(status({ hasGitHubRemote: false, hasWorkingTreeChanges: true })), noGitHub);
    assert.deepEqual(resolveCreatePullRequestButton(status({ hasGitHubRemote: false, hasUpstream: false, aheadCount: 1 })), noGitHub);
    assert.deepEqual(resolveCreatePullRequestButton(status({ isRepo: false, refName: null })), { kind: "disabled", hint: "Not a Git repository." });
  });
});

describe("progress and messages", () => {
  const run: RunningCreatePullRequest = { status: "running", label: "Pushing...", lastOutputLine: null, phaseStartedAt: 6_000 };

  it("shows the progress and the step's elapsed time", () => {
    assert.deepEqual(resolveCreatePullRequestProgress(null, 10_000), { label: "Starting...", output: null });
    assert.deepEqual(resolveCreatePullRequestProgress(run, 11_500), { label: "Pushing... 5s", output: null });
    assert.deepEqual(resolveCreatePullRequestProgress({ ...run, lastOutputLine: " hook: lint " }, 76_000), { label: "Pushing... 1m 10s", output: "hook: lint" });
  });

  it("formats the title and the success toast", () => {
    assert.equal(createPullRequestTitle(null), "Create PR");
    assert.equal(createPullRequestTitle("Pushing...", "Publish"), "Publish — Pushing...");
    assert.equal(createPullRequestTitle("No local commits to push."), "Create PR — No local commits to push.");
    const pr = { number: 7, url: "u", title: "Add things" };
    assert.equal(createPullRequestToast({ commit: null, pr: { ...pr, status: "created" } }), "Created PR #7: Add things");
    assert.equal(createPullRequestToast({ commit: { sha: "abc", subject: "Fix typo" }, pr: null }), "Committed and pushed: Fix typo");
    assert.equal(createPullRequestToast({ commit: null, pr: null }), "Pushed");
    assert.equal(createPullRequestToast({ commit: null, pr: { ...pr, status: "opened_existing", title: "x".repeat(80) } }), `Opened PR #7: ${"x".repeat(69)}...`);
  });
});
