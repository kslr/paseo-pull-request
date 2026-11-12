import test from "node:test";
import assert from "node:assert/strict";
import { PullRequestService } from "./service.ts";
import type { Runner } from "../process.ts";
import { CommandError } from "../process.ts";
import { updateRpc } from "../../shared/pullRequest.ts";

const ref = { directory: "/workspace", repository: "owner/repo", number: 12 };
const remote = "origin\tgit@github.com:owner/repo.git (fetch)\n";
function checkPr(...nodes: object[]) {
  return { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: false } } } } }] } };
}
const success = (name: string) => checkPr({ name, status: "COMPLETED", conclusion: "SUCCESS" });
function detailRepo(pr: object = {}, repo: object = {}) {
  return {
    viewerPermission: "WRITE", defaultBranchRef: { name: "main" },
    mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true,
    pullRequest: {
      number: 12, url: "https://github.com/owner/repo/pull/12", title: "Title", body: "Description",
      author: { login: "author" }, state: "OPEN", isDraft: false,
      mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED",
      additions: 3, deletions: 1, changedFiles: 2, headRefName: "feature", baseRefName: "main",
      isCrossRepository: false, headRef: { id: "branch" }, headRepository: { viewerPermission: "WRITE" },
      updatedAt: "2026-11-09", mergedAt: null, closedAt: null,
      autoMergeRequest: { mergeMethod: "SQUASH" }, viewerCanUpdate: true, ...pr,
    },
    ...repo,
  };
}
const writeState = (pr: object = {}) => ({ data: { repository: { id: "repo", defaultBranchRef: { name: "main" }, pullRequest: {
  id: "PR", state: "MERGED", isCrossRepository: false, headRefName: "feature", headRefOid: "head", headRef: { target: { oid: "head" } }, isMergeQueueEnabled: false, ...pr,
} } } });
function mock(api: (body: any) => unknown) {
  const calls: { body: any; args: string[] }[] = [];
  const runner: Runner = async (file, args, options) => {
    if (file === "git") return { stdout: args[0] === "remote" ? remote : "feature\n", stderr: "" };
    assert.equal(options.cwd, ref.directory);
    if (args[0] === "auth") return { stdout: "", stderr: "" };
    const body = JSON.parse(options.input!);
    calls.push({ body, args });
    return { stdout: JSON.stringify(api(body)), stderr: "" };
  };
  const mutations = () => calls.filter(call => call.body.query.startsWith("mutation"));
  return { service: new PullRequestService(runner), calls, mutations };
}

test("resolve finds the branch's pull request and tells missing gh from failed auth", async () => {
  const { service } = mock(() => ({ data: { repository: { open: { nodes: [] }, latest: { nodes: [{ number: 5, url: "u", title: "t", state: "MERGED" }] } } } }));
  assert.deepEqual(await service.resolve(ref), { status: "found", repository: "owner/repo", number: 5 });
  for (const [code, reason] of [["ENOENT", "gh-missing"], [1, "gh-unauthenticated"]] as const) {
    const runner: Runner = async file => { if (file === "git") return { stdout: remote, stderr: "" }; throw new CommandError("auth failed", code); };
    const result = await new PullRequestService(runner).resolve(ref);
    assert.equal(result.status, "unavailable"); if (result.status === "unavailable") assert.equal(result.reason, reason);
  }
});

test("reads are cached until refresh", async () => {
  let count = 0;
  const { service } = mock(() => ({ data: { repository: { pullRequest: success(`check${++count}`) } } }));
  assert.equal((await service.checks(ref)).checks[0].name, "check1");
  await service.checks(ref); assert.equal(count, 1);
  await service.refresh(ref); await service.checks(ref); assert.equal(count, 2);
});

test("a failed read is not cached", async () => {
  let reads = 0;
  const { service } = mock(() => ++reads === 1 ? { errors: [{ message: "Something went wrong" }] } : { data: { repository: { pullRequest: success("CI") } } });
  await assert.rejects(service.checks(ref), /Something went wrong/);
  assert.equal((await service.checks(ref)).checks[0].name, "CI");
  await service.checks(ref); assert.equal(reads, 2);
});

test("refresh prevents an in-flight old read from repopulating the cache", async () => {
  let unblock!: (value: { stdout: string; stderr: string }) => void;
  let reads = 0;
  const runner: Runner = async (file) => {
    if (file === "git") return { stdout: remote, stderr: "" };
    reads++;
    if (reads === 1) return new Promise(resolve => { unblock = resolve; });
    return { stdout: JSON.stringify({ data: { repository: { pullRequest: success("new") } } }), stderr: "" };
  };
  const service = new PullRequestService(runner);
  const old = service.checks(ref);
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  await service.refresh(ref);
  assert.equal((await service.checks(ref)).checks[0].name, "new");
  unblock({ stdout: JSON.stringify({ data: { repository: { pullRequest: success("old") } } }), stderr: "" });
  await old;
  assert.equal((await service.checks(ref)).checks[0].name, "new"); assert.equal(reads, 2);
});

test("detail maps GitHub's pull request and the viewer's permissions", async () => {
  const { service, calls } = mock(() => ({ data: { repository: detailRepo() } }));
  const detail = await service.detail(ref);
  assert.equal(detail.title, "Title");
  assert.deepEqual(detail.author, { login: "author" });
  assert.equal(detail.reviewDecision, "review-required");
  assert.equal(detail.autoMergeMethod, "squash");
  assert.deepEqual(detail.mergeCapabilities, { merge: false, squash: true, rebase: true });
  assert.deepEqual(detail.permissions, { actions: ["merge", "enable-auto-merge", "disable-auto-merge", "ready", "draft", "close", "reopen", "delete-branch"], editChangeRequest: true });
  await service.detail(ref);
  assert.equal(calls.length, 1);
});

test("permissions separate author, writer and branch access", async () => {
  const actions = async (pr: object, repo: object = {}) => (await mock(() => ({ data: { repository: detailRepo(pr, repo) } })).service.detail(ref)).permissions;
  assert.deepEqual(await actions({ viewerCanUpdate: false, headRepository: { viewerPermission: "READ" } }, { viewerPermission: "READ" }), { actions: [], editChangeRequest: false });
  assert.deepEqual((await actions({ headRepository: null }, { viewerPermission: "READ" })).actions, ["ready", "draft", "close", "reopen"]);
  // Auto-merge is only offered when GitHub cannot merge now.
  assert.ok(!(await actions({ mergeStateStatus: "CLEAN" })).actions.includes("enable-auto-merge"));
  for (const pr of [{ isCrossRepository: true }, { headRef: null }, { headRefName: "main" }]) assert.ok(!(await actions(pr)).actions.includes("delete-branch"));
});

test("checks paginate status contexts and check runs and map GitHub's statuses", async () => {
  const { service, calls } = mock(body => {
    const first = body.variables.after === null;
    return { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
      nodes: first
        ? [{ context: "Legacy CI", state: "PENDING", targetUrl: "https://ci.example", description: "Queued", isRequired: true }]
        : [{ name: "Build", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { workflow: { name: "CI" } } } }],
      pageInfo: { hasNextPage: first, endCursor: first ? "next" : null },
    } } } }] } } } } };
  });
  assert.deepEqual(await service.checks(ref), { checks: [
    { name: "Legacy CI", status: "pending", description: "Queued", url: "https://ci.example", required: true, workflowName: null },
    { name: "Build", status: "failure", description: null, url: null, required: null, workflowName: "CI" },
  ] });
  assert.deepEqual(calls.map(call => call.body.variables.after), [null, "next"]);

  const statuses = { QUEUED: "pending", IN_PROGRESS: "pending", EXPECTED: "pending", SUCCESS: "success", FAILURE: "failure", ERROR: "failure", TIMED_OUT: "failure", STARTUP_FAILURE: "failure", ACTION_REQUIRED: "action-required", CANCELLED: "cancelled", SKIPPED: "skipped", NEUTRAL: "neutral", STALE: "neutral" };
  const mapped = mock(() => ({ data: { repository: { pullRequest: checkPr(...Object.keys(statuses).map(state => ({ context: state, state }))) } } })).service;
  assert.deepEqual(Object.fromEntries((await mapped.checks(ref)).checks.map(check => [check.name, check.status])), statuses);
});

test("missing pull requests and GraphQL errors fail reads with redacted messages", async () => {
  const missing = mock(() => ({ data: { repository: { pullRequest: null } } })).service;
  await assert.rejects(missing.checks(ref), /Pull request #12 was not found/);
  const failed = mock(() => ({ errors: [{ message: "Denied ghp_secret" }] })).service;
  await assert.rejects(failed.detail(ref), /Denied \[redacted\]/);
});

test("a merge queue and explicit auto-merge go through auto-merge; a direct merge pins the head", async () => {
  for (const [queued, action] of [[true, "merge"], [false, "enable-auto-merge"], [false, "merge"]] as const) {
    const { service, mutations } = mock(body => body.query.startsWith("mutation") ? { data: {} } : writeState({ state: "OPEN", isMergeQueueEnabled: queued }));
    await service.action({ ...ref, action, mergeMethod: "squash" });
    const [mutation] = mutations(), auto = queued || action === "enable-auto-merge";
    assert.ok(mutation.body.query.includes(auto ? "enablePullRequestAutoMerge(" : "mergePullRequest("));
    assert.deepEqual(mutation.body.variables.input, { pullRequestId: "PR", mergeMethod: "SQUASH", ...(auto ? {} : { expectedHeadOid: "head" }) });
  }
});

test("state actions route their mutations and invalidate cached checks", async () => {
  for (const [action, mutation] of [
    ["disable-auto-merge", "disablePullRequestAutoMerge"], ["ready", "markPullRequestReadyForReview"],
    ["draft", "convertPullRequestToDraft"], ["close", "closePullRequest"], ["reopen", "reopenPullRequest"],
  ] as const) {
    let reads = 0;
    const { service, mutations } = mock(body => {
      if (body.query.includes("contexts(first:")) { reads++; return { data: { repository: { pullRequest: success("CI") } } }; }
      return body.query.startsWith("mutation") ? { data: {} } : writeState();
    });
    await service.checks(ref);
    assert.deepEqual(await service.action({ ...ref, action }), { ok: true });
    const [write] = mutations();
    assert.ok(write.body.query.includes(`mutation($input:${mutation[0].toUpperCase()}${mutation.slice(1)}Input!) { ${mutation}(`));
    assert.deepEqual(write.body.variables.input, { pullRequestId: "PR" });
    await service.checks(ref);
    assert.equal(reads, 2);
  }
});

test("branch deletion pins the branch and its head, and refuses unsafe branches without a write", async () => {
  const { service, mutations } = mock(body => body.query.startsWith("mutation") ? { data: {} } : writeState());
  await service.action({ ...ref, action: "delete-branch" });
  assert.deepEqual(mutations()[0].body.variables.input, { repositoryId: "repo", refUpdates: [{ name: "refs/heads/feature", beforeOid: "head", afterOid: "0".repeat(40) }] });
  for (const [patch, message] of [
    [{ isCrossRepository: true }, /fork/], [{ state: "OPEN" }, /Close or merge/], [{ headRefName: "main" }, /default branch/],
    [{ headRef: null }, /no longer exists/], [{ headRef: { target: { oid: "new-commit" } } }, /new commits/],
  ] as const) {
    const unsafe = mock(() => writeState(patch));
    await assert.rejects(unsafe.service.action({ ...ref, action: "delete-branch" }), message);
    assert.equal(unsafe.mutations().length, 0);
  }
});

test("update sends only the given fields through JSON stdin", async () => {
  const { service, calls, mutations } = mock(body => body.query.startsWith("mutation") ? { data: {} } : writeState());
  const input = updateRpc.input.parse({ ...ref, body: "  code\nline  \n$(touch /tmp/no)" });
  assert.deepEqual(await service.update(input), { ok: true });
  assert.deepEqual(mutations()[0].body.variables.input, { pullRequestId: "PR", body: input.body });
  assert.ok(!calls.some(call => call.args.includes(input.body!)));
  await service.update(updateRpc.input.parse({ ...ref, title: "New title", body: "" }));
  assert.deepEqual(mutations()[1].body.variables.input, { pullRequestId: "PR", title: "New title", body: "" });
  assert.throws(() => updateRpc.input.parse(ref), /Nothing was changed/);
});
