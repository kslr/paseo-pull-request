import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePaseo } from "./fakePaseo.ts";
import { CreatePullRequestService } from "./service.ts";
import { featureBranchName } from "./branchName.ts";
import { parseWorkingTree } from "./repository.ts";
import { parseCreatedPullRequest } from "./run.ts";
import { CommandError, runCommand } from "../process.ts";
import type { Runner, CommandOptions } from "../process.ts";
import { gitStatusSchema, createPullRequestRunSchema } from "../../shared/createPullRequest.ts";
import type { CreatePullRequestRun } from "../../shared/createPullRequest.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const noPullRequests = JSON.stringify({ data: { repository: { open: { nodes: [] }, latest: { nodes: [] } } } });
const openPr = { number: 7, title: "Existing change", url: "https://github.com/owner/repo/pull/7", state: "OPEN" };
const openPrResponse = JSON.stringify({ data: { repository: { open: { nodes: [openPr] }, latest: { nodes: [] } } } });
// gh as GitHub would answer: main is the default branch, the branch has no pull request, and creating one makes #8.
const gitHub: Runner = async (_file, args) => ({ stdout: args[0] === "pr" ? "https://github.com/owner/repo/pull/8\n" : args[0] === "repo" ? JSON.stringify({ defaultBranchRef: { name: "main" } }) : noPullRequests, stderr: "" });

// A checkout on main with one commit, pushed to a bare origin that the GitHub remote stands for.
async function harness(gh: Runner = gitHub, api = fakePaseo()) {
  const root = await mkdtemp(join(tmpdir(), "create-pr-test-")), directory = join(root, "checkout"), bare = join(root, "remote.git");
  await mkdir(directory);
  const git = async (args: string[], cwd = directory) => (await runCommand("git", args, { cwd })).stdout.trim();
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]); await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "commit.gpgsign", "false"]); await git(["config", "core.hooksPath", join(directory, ".git/hooks")]);
  await writeFile(join(directory, "tracked.txt"), "first\n");
  await git(["add", "-A"]); await git(["commit", "-m", "Initial"]);
  await git(["init", "--bare", "-b", "main", bare]); await git(["remote", "add", "origin", bare]);
  await git(["push", "-u", "origin", "main"]); await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const calls: { file: string; args: string[]; options: CommandOptions }[] = [];
  const runner: Runner = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === "git") {
      assert.ok(options.cwd.startsWith(root), "real git commands must stay inside the temporary fixture");
      if (args[0] === "remote" && args[1] === "-v") return { stdout: "origin\tgit@github.com:owner/repo.git (fetch)\n", stderr: "" };
      return runCommand(file, args, options);
    }
    assert.equal(file, "gh", `unexpected command ${file}`);
    return gh(file, args, options);
  };
  const service = new CreatePullRequestService(runner);
  const start = (runId: string) => service.start({ directory, runId, workspaceId: "wks_test" }, api.paseo);
  async function settled(runId: string): Promise<CreatePullRequestRun> {
    for (let i = 0; i < 1000; i++) {
      const state = createPullRequestRunSchema.parse(service.poll({ directory, runId }));
      if (state.status !== "running") return state;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("The run did not settle.");
  }
  const run = async (runId = "run") => { start(runId); return settled(runId); };
  const prCreate = () => calls.find(c => c.file === "gh" && c.args[0] === "pr");
  return { root, directory, bare, git, service, calls, api, start, settled, run, prCreate, async dispose() { await service.cleanup(); await rm(root, { recursive: true, force: true }); } };
}
function succeeded(state: CreatePullRequestRun) {
  assert.equal(state.status, "succeeded", state.status === "failed" ? state.message : undefined);
  if (state.status !== "succeeded") throw new Error("Expected success");
  return state.result;
}
const generated = (fields: object = {}) => fakePaseo(() => ({ commitMessage: "Add feature.", title: "Add feature", body: "Summary", branch: "add-feature", ...fields }));

test("status reports changes, upstream and how far the branch is ahead of the default branch", async () => {
  const h = await harness();
  try {
    await mkdir(join(h.directory, "sub"));
    assert.deepEqual(gitStatusSchema.parse(await h.service.status({ directory: join(h.directory, "sub") })), {
      isRepo: true, hasGitHubRemote: true, isDefaultRef: true, refName: "main", hasWorkingTreeChanges: false,
      hasUpstream: true, aheadCount: 0, behindCount: 0, aheadOfDefaultCount: 0, pr: null,
    });
    await h.git(["checkout", "-b", "feature"]);
    await writeFile(join(h.directory, "new.txt"), "new\n"); await h.git(["add", "-A"]); await h.git(["commit", "-m", "Change"]);
    await writeFile(join(h.directory, "untracked.txt"), "untracked\n");
    const feature = await h.service.status(h);
    assert.equal(feature.isDefaultRef, false); assert.equal(feature.hasWorkingTreeChanges, true);
    assert.equal(feature.hasUpstream, false); assert.equal(feature.aheadCount, 1); assert.equal(feature.aheadOfDefaultCount, 1);
    assert.equal((await h.service.status({ directory: h.root })).isRepo, false);
  } finally { await h.dispose(); }
});

test("missing gh leaves status usable, and the default branch falls back to repo view", async () => {
  const h = await harness(async () => { throw new CommandError("spawn gh ENOENT", "ENOENT"); });
  try { assert.equal((await h.service.status(h)).pr, null); }
  finally { await h.dispose(); }
  const other = await harness();
  try {
    await other.git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    assert.equal((await other.service.status(other)).isDefaultRef, true);
    assert.deepEqual(other.calls.find(c => c.file === "gh" && c.args[0] === "repo")!.args, ["repo", "view", "github.com/owner/repo", "--json", "defaultBranchRef"]);
  } finally { await other.dispose(); }
});

test("on the default branch, one generation names the commit, a unique feature branch and the PR", async () => {
  const api = generated({ body: "## Summary\nFeature\n$(literal)" });
  const h = await harness(gitHub, api);
  try {
    await h.git(["branch", "feature/add-feature"]); await writeFile(join(h.directory, "new.txt"), "new\n");
    const result = succeeded(await h.run());
    assert.equal(result.branch, "feature/add-feature-2");
    assert.equal(result.commit?.subject, "Add feature");
    assert.deepEqual(result.pr, { status: "created", number: 8, url: "https://github.com/owner/repo/pull/8", title: "Add feature" });
    assert.deepEqual(h.prCreate()!.args, ["pr", "create", "--repo", "github.com/owner/repo", "--base", "main", "--head", "feature/add-feature-2", "--title", "Add feature", "--body-file", "-"]);
    assert.ok(h.prCreate()!.options.input!.endsWith("$(literal)"));
    assert.equal(await h.git(["rev-parse", "refs/heads/feature/add-feature-2"], h.bare), result.commit?.sha);
    assert.deepEqual(api.created.map(input => input.title), ["Commit and PR generator"]); assert.equal(api.archived.length, 1);
  } finally { await h.dispose(); }
});

for (const onDefault of [true, false]) test(`generation sees everything since the merge base before anything is committed (${onDefault ? "default" : "feature"} branch)`, async () => {
  const entered = deferred(), release = deferred();
  const api = fakePaseo(async () => { entered.resolve(); await release.promise; return { commitMessage: "Add staged work", title: "All changes", body: "Summary", branch: "parallel-work" }; });
  const h = await harness(gitHub, api);
  try {
    const base = await h.git(["rev-parse", "HEAD"]);
    if (!onDefault) {
      await h.git(["checkout", "-b", "source"]);
      await writeFile(join(h.directory, "committed.txt"), "earlier change\n");
      await h.git(["add", "-A"]); await h.git(["commit", "-m", "Earlier work"]);
      // The base moves on independently: the PR text must use the merge base, not the base's tip.
      await h.git(["checkout", "main"]);
      await writeFile(join(h.directory, "base-only.txt"), "unrelated base change\n");
      await h.git(["add", "-A"]); await h.git(["commit", "-m", "Base advanced"]);
      await h.git(["push", "origin", "main"]); await h.git(["checkout", "source"]);
    }
    await writeFile(join(h.directory, "staged.txt"), "pending staged change\n");
    h.start("run");
    await entered.promise;
    const progress = h.service.poll({ directory: h.directory, runId: "run" });
    assert.equal(progress.status === "running" && progress.label, "Generating commit message and PR...");
    assert.ok(!h.calls.some(c => c.args.some(arg => ["commit", "push", "checkout", "switch", "pr"].includes(arg))));
    const prompt = api.created[0].prompt!;
    assert.ok(prompt.includes("+pending staged change")); assert.ok(prompt.includes("A\tstaged.txt\t(+1 -0)"));
    assert.equal(prompt.includes("Branch style:"), onDefault);
    if (!onDefault) { assert.ok(prompt.includes("+earlier change")); assert.ok(!prompt.includes("base-only.txt")); }
    assert.ok(h.calls.some(c => c.args[0] === "diff" && c.args.includes("--cached") && c.args.includes(base)));
    release.resolve();
    const result = succeeded(await h.settled("run"));
    assert.equal(result.pr.status, "created");
    assert.equal(result.branch, onDefault ? "feature/parallel-work" : null);
    assert.ok(prompt.includes(await h.git(["diff", "origin/main...HEAD", "--no-ext-diff"])));
  } finally { release.resolve(); await h.dispose(); }
});

test("with nothing to commit, only the PR text is generated, from the committed changes", async () => {
  const api = fakePaseo(() => ({ title: "Committed work", body: "Summary" }));
  const h = await harness(gitHub, api);
  try {
    await h.git(["checkout", "-b", "feature"]); await writeFile(join(h.directory, "committed.txt"), "committed\n");
    await h.git(["add", "-A"]); await h.git(["commit", "-m", "Committed work"]);
    const result = succeeded(await h.run());
    assert.equal(result.commit, null); assert.equal(result.pr.title, "Committed work");
    assert.deepEqual(api.created.map(input => input.title), ["PR generator"]);
    assert.ok(api.created[0].prompt!.includes("committed.txt"));
    assert.equal(await h.git(["rev-parse", "refs/heads/feature"], h.bare), await h.git(["rev-parse", "HEAD"]));
  } finally { await h.dispose(); }
});

test("an open PR on the branch is opened instead of created, and the status cache is dropped", async () => {
  let lookups = 0;
  const h = await harness(async () => { lookups++; return { stdout: openPrResponse, stderr: "" }; });
  try {
    await h.git(["checkout", "-b", "feature"]);
    assert.equal((await h.service.status(h)).pr?.number, 7); await h.service.status(h); assert.equal(lookups, 1);
    await writeFile(join(h.directory, "new"), "new"); await h.git(["add", "-A"]); await h.git(["commit", "-m", "Change"]);
    const result = succeeded(await h.run());
    assert.deepEqual(result.pr, { status: "opened_existing", number: 7, url: openPr.url, title: openPr.title });
    await h.service.status(h); assert.equal(lookups, 3);
    assert.ok(!h.calls.some(c => c.file === "claude" || (c.file === "gh" && c.args[0] === "pr")));
    assert.equal(h.api.created.length, 0);
  } finally { await h.dispose(); }
});

test("a branch tracking a differently named base is published under its own name", async () => {
  const h = await harness();
  try {
    const main = await h.git(["rev-parse", "main"]);
    await h.git(["checkout", "-b", "feature", "origin/main"]);
    await writeFile(join(h.directory, "feature"), "feature");
    const result = succeeded(await h.run());
    assert.equal(await h.git(["rev-parse", "refs/heads/main"], h.bare), main);
    assert.equal(await h.git(["rev-parse", "refs/heads/feature"], h.bare), result.commit?.sha);
  } finally { await h.dispose(); }
});

test("the push goes where git push would, such as the configured push remote", async () => {
  const h = await harness(gitHub, generated());
  try {
    const other = join(h.root, "other.git");
    await h.git(["init", "--bare", "-b", "main", other]); await h.git(["remote", "add", "other", other]);
    await h.git(["config", "remote.pushDefault", "other"]);
    await h.git(["checkout", "-b", "feature"]); await writeFile(join(h.directory, "new"), "new");
    const result = succeeded(await h.run());
    assert.equal(await h.git(["rev-parse", "refs/heads/feature"], other), result.commit?.sha);
    assert.equal(await h.git(["rev-parse", "--abbrev-ref", "@{upstream}"]), "other/feature");
  } finally { await h.dispose(); }
});

test("one run at a time per checkout, the same runId returns the same run, and cleanup aborts and archives", async () => {
  const entered = deferred(), release = deferred();
  const api = fakePaseo(async () => { entered.resolve(); await release.promise; return { commitMessage: "Never commit", title: "t", body: "b" }; });
  const h = await harness(gitHub, api);
  try {
    await h.git(["checkout", "-b", "feature"]); await writeFile(join(h.directory, "new"), "new");
    const first = h.start("one"); assert.equal(first.status, "running"); assert.deepEqual(h.start("one"), first);
    assert.throws(() => h.start("two"), /already in progress/);
    await entered.promise;
    await h.service.cleanup(); assert.throws(() => h.start("three"), /stopping/);
    assert.equal(api.created.length, 1); assert.equal(api.archived.length, 1); assert.ok(!h.calls.some(c => c.args[0] === "commit"));
  } finally { release.resolve(); await h.dispose(); }
});

test("a failing hook stops the run with its message", async () => {
  const h = await harness(gitHub, generated());
  try {
    await h.git(["checkout", "-b", "feature"]); await writeFile(join(h.directory, "new"), "new");
    const hook = join(h.directory, ".git/hooks/pre-commit"); await writeFile(hook, "#!/bin/sh\necho 'Hook rejected commit.' >&2\nexit 1\n"); await chmod(hook, 0o755);
    const state = await h.run("hook");
    assert.deepEqual(state, { status: "failed", message: "Hook rejected commit." });
    assert.ok(!h.calls.some(c => c.args.includes("push") || c.args[0] === "pr"));
    assert.equal(await h.git(["log", "-1", "--format=%s"]), "Initial");
  } finally { await h.dispose(); }
});

test("hook output shows as progress, with secrets redacted", async () => {
  const h = await harness(gitHub, generated());
  try {
    await h.git(["checkout", "-b", "feature"]); await writeFile(join(h.directory, "new"), "new");
    const hook = join(h.directory, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho 'Authorization: Bearer secret-token' >&2\nsleep 1\n"); await chmod(hook, 0o755);
    h.start("progress");
    let observed = false;
    for (let i = 0; i < 400 && !observed; i++) {
      const state = h.service.poll({ directory: h.directory, runId: "progress" });
      if (state.status === "running" && state.lastOutputLine?.includes("Authorization")) { assert.ok(!state.lastOutputLine.includes("secret-token")); observed = true; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(observed, true); succeeded(await h.settled("progress"));
  } finally { await h.dispose(); }
});

test("detached HEAD, and the default branch with nothing to commit, fail without pushing", async () => {
  const h = await harness();
  try {
    assert.match((await h.run("clean-main") as { message: string }).message, /no changes to commit/);
    await h.git(["checkout", "--detach"]);
    assert.match((await h.run("detached") as { message: string }).message, /detached HEAD/);
    assert.ok(!h.calls.some(c => c.args.includes("push")));
  } finally { await h.dispose(); }
});

test("feature branch names avoid existing branches and directory conflicts", () => {
  assert.equal(featureBranchName([], "Add Login Form!"), "feature/add-login-form");
  assert.equal(featureBranchName([], "fix/typo"), "fix/typo");
  assert.equal(featureBranchName([]), "feature/update");
  assert.equal(featureBranchName(["FEATURE"], "hello"), "feature-2/hello");
  assert.equal(featureBranchName(["feature/hello/child", "feature/hello-2"], "hello"), "feature/hello-3");
});

test("porcelain status headers and records give the branch, its upstream counts and whether anything changed", () => {
  const header = (...lines: string[]) => lines.map(line => `# ${line}`).join("\0");
  assert.deepEqual(parseWorkingTree(`${header("branch.oid abc", "branch.head feature", "branch.upstream origin/feature", "branch.ab +2 -1")}\0`), { refName: "feature", unborn: false, hasUpstream: true, ahead: 2, behind: 1, hasChanges: false });
  assert.deepEqual(parseWorkingTree(`${header("branch.oid (initial)", "branch.head main")}\0? new.txt\0`), { refName: "main", unborn: true, hasUpstream: false, ahead: 0, behind: 0, hasChanges: true });
  assert.equal(parseWorkingTree(header("branch.oid abc", "branch.head (detached)")).refName, null);
});

test("the created pull request is read from gh's last line", () => {
  assert.deepEqual(parseCreatedPullRequest("Creating pull request for feature into main\n\nhttps://github.com/owner/repo/pull/8\n"), { number: 8, url: "https://github.com/owner/repo/pull/8" });
  assert.throws(() => parseCreatedPullRequest("Warning: something\n"), /did not return a pull request URL: Warning: something$/);
});

// Another clone moves the remote's main on, leaving this checkout's main and origin/main behind.
async function advanceRemoteMain(h: Awaited<ReturnType<typeof harness>>, file: string, content: string) {
  const other = join(h.root, "other");
  await h.git(["clone", "--quiet", h.bare, other], h.root);
  await h.git(["config", "user.name", "Other"], other); await h.git(["config", "user.email", "other@example.invalid"], other);
  await writeFile(join(other, file), content);
  await h.git(["add", "-A"], other); await h.git(["commit", "-m", "Remote moved on"], other); await h.git(["push", "--quiet", "origin", "main"], other);
  return h.git(["rev-parse", "HEAD"], other);
}

test("a feature branch from a main that is only behind starts at the fetched remote tip", async () => {
  const api = generated({ branch: "local-work" });
  const h = await harness(gitHub, api);
  try {
    const remoteTip = await advanceRemoteMain(h, "remote-only.txt", "already on main\n");
    await writeFile(join(h.directory, "local.txt"), "local change\n");
    assert.equal(succeeded(await h.run()).branch, "feature/local-work");
    assert.equal(await h.git(["rev-parse", "HEAD^"]), remoteTip, "the branch starts at the remote's current main");
    assert.equal(await h.git(["show", "HEAD:local.txt"]), "local change");
    assert.ok(!api.created[0].prompt!.includes("remote-only.txt"), "merged remote work is not described as the PR's");
  } finally { await h.dispose(); }
});

test("a feature branch falls back to HEAD when the changes collide with the remote's", async () => {
  const h = await harness(gitHub, generated({ branch: "edit-tracked" }));
  try {
    await advanceRemoteMain(h, "tracked.txt", "remote edit\n");
    const localHead = await h.git(["rev-parse", "HEAD"]);
    await writeFile(join(h.directory, "tracked.txt"), "local edit\n");
    assert.equal(succeeded(await h.run()).branch, "feature/edit-tracked");
    assert.equal(await h.git(["rev-parse", "HEAD^"]), localHead);
    assert.equal(await h.git(["show", "HEAD:tracked.txt"]), "local edit");
  } finally { await h.dispose(); }
});
