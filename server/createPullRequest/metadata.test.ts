import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { GitRepository } from "./repository.ts";
import { GitMetadataGenerator, extractJsonFromMarkdown } from "./metadata.ts";
import { resolveStructuredGenerationProviders, readOnlyGenerationConfig } from "./providers.ts";
import { fakePaseo } from "./fakePaseo.ts";
import type { Runner } from "../process.ts";

const entry = (provider: string, ids: string[]): ProviderSnapshotEntry => ({ provider, enabled: true, status: "ready", models: ids.map(id => ({ provider, id, label: id })) });
const pr = { title: "PR", body: "Body" };
// `claude` answers the direct Claude Code path; by default the CLI is missing (ENOENT).
type Claude = (args: string[], input: string) => Promise<string>;
const missingClaude: Claude = async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); };
async function harness(api = fakePaseo(() => pr), patch = "+ change", claude: Claude = missingClaude) {
  const root = await mkdtemp(join(tmpdir(), "git-metadata-test-"));
  const calls: string[][] = [];
  const run: Runner = async (file, args, options) => {
    if (file === "claude") return { stdout: await claude(args, options.input ?? ""), stderr: "" };
    assert.equal(file, "git"); calls.push(args);
    const stdout = args[0] === "rev-parse" ? root : args[0] === "merge-base" ? "merge-base-sha" : args.includes("--numstat") ? "1\t0\tnew file.ts\0" : args.includes("--name-status") ? "A\0new file.ts\0" : patch;
    return { stdout, stderr: "" };
  };
  const generator = new GitMetadataGenerator(api.paseo, "wks_test", new GitRepository(root, run), new AbortController().signal);
  return { root, generator, calls, async dispose() { await rm(root, { recursive: true, force: true }); } };
}

test("a configured list is Manual: only its models, in order, nested models resolved", async () => {
  const entries = [entry("claude", ["claude-haiku"]), entry("codex", ["gpt-5.4-mini"]), entry("opencode", ["nested/custom", "minimax-m3", "nemotron-3-super"]), { ...entry("disabled", ["haiku"]), enabled: false }];
  entries[1].models![0].thinkingOptions = [{ id: "low", label: "Low" }];
  entries[2].models![0].metadata = { providerId: "nested", modelId: "custom" };
  const api = fakePaseo(undefined, { entries, providers: [{ provider: "nested", model: "custom" }, { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" }, { provider: "claude" }, { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" }] });
  assert.deepEqual((await resolveStructuredGenerationProviders(api.paseo, "/test")).providers, [
    { provider: "opencode", model: "nested/custom", thinkingOptionId: undefined },
    { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
    { provider: "claude", model: "claude-haiku", thinkingOptionId: undefined },
  ]);
});

test("an empty list is Automatic: built-in defaults over enabled providers", async () => {
  const entries = [entry("claude", ["claude-haiku"]), entry("codex", ["gpt-5.4-mini"]), entry("opencode", ["minimax-m3", "nemotron-3-super"]), { ...entry("disabled", ["haiku"]), enabled: false }];
  entries[1].models![0].thinkingOptions = [{ id: "low", label: "Low" }];
  const api = fakePaseo(undefined, { entries });
  assert.deepEqual((await resolveStructuredGenerationProviders(api.paseo, "/test")).providers, [
    { provider: "claude", model: "claude-haiku", thinkingOptionId: undefined },
    { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
    { provider: "opencode", model: "minimax-m3", thinkingOptionId: undefined },
    { provider: "opencode", model: "nemotron-3-super", thinkingOptionId: undefined },
  ]);
});

test("one generation asks for each part with its paseo.json style, and never for a branch name", async () => {
  const api = fakePaseo(() => ({ commitMessage: "Add thing.\nmore", title: "Add thing", body: "Body" }));
  const h = await harness(api, "x".repeat(210_000));
  try {
    await writeFile(join(h.root, "paseo.json"), JSON.stringify({ metadataGeneration: { commitMessage: { instructions: "Chinese commits." } } }));
    assert.deepEqual(await h.generator.commitAndPullRequest("refs/remotes/origin/main"), { commitMessage: "Add thing", title: "Add thing", body: "Body" });
    const { prompt, title, labels, workspaceId, config, outputSchema } = api.created[0];
    assert.equal(title, "Commit and PR generator");
    for (const text of ["Commit message style:\nChinese commits.", "Pull request style:\nClear, descriptive title", "fields 'commitMessage', 'title' and 'body'.", "A\tnew file.ts\t(+1 -0)", "diff truncated to 200000 chars"]) assert.ok(prompt!.includes(text), text);
    assert.ok(!prompt!.includes("Concise, imperative mood")); assert.ok(!/branch/i.test(prompt!.split("Files changed:")[0]));
    assert.deepEqual(labels, { "paseo-pull-request": "generator" }); assert.equal(workspaceId, "wks_test");
    assert.deepEqual(config.options, { sandbox_mode: "read-only", approval_policy: "never" }); assert.equal(config.thinkingOptionId, "low");
    assert.equal(outputSchema!.type, "object");
    // The diff runs from the merge base to the index.
    assert.deepEqual(h.calls.find(args => args[0] === "merge-base"), ["merge-base", "refs/remotes/origin/main", "HEAD"]);
    assert.deepEqual(h.calls.filter(args => args[0] === "diff").map(args => args.slice(0, 3)), Array(3).fill(["diff", "--cached", "merge-base-sha"]));

    await h.generator.pullRequest("refs/remotes/origin/main");
    assert.equal(api.created[1].title, "PR generator");
    assert.ok(api.created[1].prompt!.startsWith("Write a pull request title and body for the changes below.\n\nPull request style:"));
    assert.ok(!api.created[1].prompt!.includes("commitMessage"));
    assert.deepEqual(api.archived, [1, 2]);
  } finally { await h.dispose(); }
});

test("an invalid response is retried twice, then the next provider answers; every agent is archived", async () => {
  const api = fakePaseo(input => input.config.provider.startsWith("claude/") ? "bad json" : `Result follows: ${JSON.stringify(pr)} done.`, { entries: [entry("claude", ["haiku"]), entry("codex", ["gpt-5.4-mini"])] });
  const h = await harness(api);
  try {
    assert.deepEqual(await h.generator.pullRequest("main"), pr);
    assert.equal(api.retries.length, 2); assert.ok(api.retries[0].includes("Previous response was invalid"));
    assert.deepEqual(api.created.map(v => v.config.provider), ["claude/haiku", "codex/gpt-5.4-mini"]); assert.deepEqual(api.archived, [1, 2]);
    assert.deepEqual(api.created[0].config.options, { extraArgs: { tools: "" }, disallowedTools: ["*"] });
  } finally { await h.dispose(); }
});

test("when every provider fails, generation stops with an error instead of placeholder text", async () => {
  for (const failure of ["error", "schema", "create", "empty", "timeout"] as const) {
    const api = fakePaseo(() => {
      if (failure === "error") throw new Error("Provider unavailable");
      return failure === "timeout" ? { status: "timeout", error: "Unavailable", final: null, lastMessage: null } : { wrong: true };
    }, failure === "empty" ? { entries: [] } : { createError: failure === "create" });
    const h = await harness(api);
    try {
      await assert.rejects(h.generator.pullRequest("main"), /^Error: Could not write the pull request: no model in Paseo's metadata generation settings gave a valid answer\.$/);
      await assert.rejects(h.generator.commitAndPullRequest("main"), /Could not write the commit message and pull request/);
      assert.equal(api.archived.length, failure === "create" || failure === "empty" ? 0 : 2);
      assert.equal(api.retries.length, failure === "schema" ? 4 : 0);
    } finally { await h.dispose(); }
  }
  // A commit message with no subject line once cleaned up is an invalid answer, and retried.
  const blank = fakePaseo(() => ({ commitMessage: "...", title: "PR", body: "Body" }));
  const h = await harness(blank);
  try {
    await assert.rejects(h.generator.commitAndPullRequest("main"), /Could not write/);
    assert.equal(blank.retries.length, 2); assert.ok(blank.retries[0].includes("commitMessage: Needs a subject line."));
  } finally { await h.dispose(); }
});

test("archiving does not hold up the result, and a failure only logs the agent id and error", async t => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const api = fakePaseo(() => pr, { archive: () => pending, archiveError: true });
  const h = await harness(api), errors = t.mock.method(console, "error", () => {});
  try {
    assert.deepEqual(await h.generator.pullRequest("main"), pr);
    assert.deepEqual(api.archived, [1]);
    assert.equal(errors.mock.callCount(), 0);
    release();
    await new Promise(resolve => setImmediate(resolve));
    const [message, error] = errors.mock.calls[0].arguments as unknown as [string, Error];
    assert.match(message, /metadata agent 1/); assert.equal(error.message, "Archive failed");
  } finally { release(); await h.dispose(); }
});

test("only providers with enforceable read-only or no-tools settings may generate", () => {
  for (const provider of ["codex", "claude", "opencode"]) assert.ok(readOnlyGenerationConfig({ provider }, entry(provider, [])));
  assert.equal(readOnlyGenerationConfig({ provider: "custom" }, entry("custom", [])), null);
  assert.equal(readOnlyGenerationConfig({ provider: "custom" }, { ...entry("custom", []), modes: [{ id: "read-only", label: "Read only" }] })?.modeId, "read-only");
});

test("response parser handles fenced JSON, prose, nested structures and braces in strings", () => {
  for (const input of ['```json\n{"message":"Commit"}\n```', 'Prose {"message":"Commit"} after']) assert.deepEqual(JSON.parse(extractJsonFromMarkdown(input)), { message: "Commit" });
  assert.deepEqual(JSON.parse(extractJsonFromMarkdown('before {"nested":{"value":"} \\\""}} after')), { nested: { value: '} "' } });
});

test("a Claude candidate runs one-shot claude -p without tools, and no agent is created", async () => {
  const api = fakePaseo(undefined, { entries: [entry("claude", ["claude-haiku-5-5"])] });
  const seen: string[][] = [];
  const h = await harness(api, "+ change", async args => { seen.push(args); return JSON.stringify(pr); });
  try {
    assert.deepEqual(await h.generator.pullRequest("main"), pr);
    assert.equal(api.created.length, 0);
    assert.deepEqual(seen[0].slice(0, 3), ["-p", "--model", "claude-haiku-5-5"]);
    assert.equal(seen[0][seen[0].indexOf("--tools") + 1], "");
    assert.ok(seen[0].includes("--strict-mcp-config"));
  } finally { await h.dispose(); }
});

test("claude -p retries invalid JSON twice, and a failure moves on to the next provider", async () => {
  const entries = [entry("claude", ["claude-haiku-5-5"]), entry("codex", ["gpt-5.4-mini"])];
  const fromCodex = { title: "From codex", body: "Body" };
  const inputs: string[] = [];
  const api = fakePaseo(() => fromCodex, { entries });
  const h = await harness(api, "+ change", async (_args, input) => { inputs.push(input); return "not json"; });
  try {
    assert.deepEqual(await h.generator.pullRequest("main"), fromCodex);
    assert.equal(inputs.length, 3); assert.ok(inputs[1].includes("Previous response was invalid"));
    assert.deepEqual(api.created.map(v => v.config.provider), ["codex/gpt-5.4-mini"]);
  } finally { await h.dispose(); }
  const failing = await harness(fakePaseo(() => fromCodex, { entries }), "+ change", async () => { throw new Error("rate limited"); });
  try { assert.deepEqual(await failing.generator.pullRequest("main"), fromCodex); } finally { await failing.dispose(); }
});
