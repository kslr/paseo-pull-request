// Writes the commit message and pull request text from the diff against the default branch, with the model Paseo's metadata generation settings choose. A Claude model runs
// as a one-shot `claude -p`; others run as a read-only agent in the workspace, archived after use.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PaseoApi, PaseoAgentHandle, PaseoAgentRunResult } from "../paseoApi.ts";
import { GitRepository } from "./repository.ts";
import { readOnlyGenerationConfig, resolveStructuredGenerationProviders } from "./providers.ts";

// paseo.json's metadataGeneration section, read as leniently as Paseo reads it: an invalid entry
// falls back to the default style.
const styleOverride = z.object({ instructions: z.string().optional() }).passthrough().optional().catch(undefined);
const PaseoConfigSchema = z.object({ metadataGeneration: z.object({ commitMessage: styleOverride, pullRequest: styleOverride }).passthrough().optional().catch(undefined) }).passthrough();
type StyleKey = "commitMessage" | "pullRequest";
type StyleOverrides = z.infer<typeof PaseoConfigSchema>["metadataGeneration"];

// What a generation can be asked for, in the order the answer lists its fields. Each part brings
// its fields and Paseo's style text for it, which paseo.json's instructions replace.
const PARTS = {
  commit: {
    fields: { commitMessage: z.string().min(1).max(72).refine(value => commitSubject(value) !== "", "Needs a subject line.").describe("Concise git commit message, imperative mood, no trailing period.") },
    style: { key: "commitMessage", label: "Commit message style", text: "Concise, imperative mood, no trailing period." },
  },
  pullRequest: {
    fields: { title: z.string().min(1).max(72), body: z.string().min(1) },
    style: { key: "pullRequest", label: "Pull request style", text: "Clear, descriptive title; body explaining what changed and why." },
  },
} satisfies Record<string, { fields: z.ZodRawShape; style: { key: StyleKey; label: string; text: string } }>;
type Part = keyof typeof PARTS;
const MAX_DIFF = 200_000;
const ATTEMPTS = 3;

export interface PullRequestText { title: string; body: string }
type Generated = PullRequestText & { commitMessage?: string };

// The first line, without trailing periods, cut to 72 characters.
function commitSubject(raw: string) {
  const [firstLine = ""] = raw.trim().split(/\r?\n/);
  return firstLine.trim().replace(/\.+$/, "").trim().slice(0, 72).trimEnd();
}

function task(parts: Part[]) {
  return parts.includes("commit")
    ? "Write a concise git commit message for the staged changes, and a pull request title and body for all the changes below (the pull request will hold the commit)."
    : "Write a pull request title and body for the changes below.";
}

// "'a', 'b' and 'c'"
const listFields = (fields: string[]) => {
  const quoted = fields.map(field => `'${field}'`);
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
};

// One line per file, its change as A, D or M and its line counts, then the patch.
function describeChanges(patch: string, numstat: string, nameStatus: string) {
  const counts = new Map<string, string>();
  for (const record of numstat.split("\0")) {
    const [added, deleted, ...path] = record.split("\t");
    if (path.length) counts.set(path.join("\t"), `(+${Number(added) || 0} -${Number(deleted) || 0})`);
  }
  const fields = nameStatus.split("\0"), files: string[] = [];
  for (let i = 1; i < fields.length; i += 2) {
    const change = fields[i - 1] === "A" || fields[i - 1] === "D" ? fields[i - 1] : "M", path = fields[i], count = counts.get(path);
    files.push(count ? `${change}\t${path}\t${count}` : `${change}\t${path}`);
  }
  return [
    files.length ? ["Files changed:", ...files].join("\n") : "Files changed: (unknown)",
    "",
    patch.length > MAX_DIFF ? `${patch.slice(0, MAX_DIFF)}\n\n... (diff truncated to ${MAX_DIFF} chars)\n` : patch || "(No diff available)",
  ];
}

function parseResponse<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; errors: string[] } {
  let value: unknown;
  try { value = JSON.parse(extractJsonFromMarkdown(text)); }
  catch (error) { return { ok: false, errors: [`Invalid JSON: ${(error as Error).message}`] }; }
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: parsed.error.issues.map(issue => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`) };
}

export class GitMetadataGenerator {
  readonly paseo: PaseoApi;
  readonly workspaceId: string;
  readonly repo: GitRepository;
  readonly signal: AbortSignal;
  constructor(paseo: PaseoApi, workspaceId: string, repo: GitRepository, signal: AbortSignal) { this.paseo = paseo; this.workspaceId = workspaceId; this.repo = repo; this.signal = signal; }

  // The staged changes' commit message and the text of the pull request that will hold them, from
  // one generation.
  async commitAndPullRequest(baseRef: string): Promise<PullRequestText & { commitMessage: string }> {
    const { title, body, commitMessage = "" } = await this.describe(baseRef, ["commit", "pullRequest"]);
    return { commitMessage: commitSubject(commitMessage), title, body };
  }
  async pullRequest(baseRef: string): Promise<PullRequestText> {
    const { title, body } = await this.describe(baseRef, ["pullRequest"]);
    return { title, body };
  }

  private async describe(baseRef: string, parts: Part[]): Promise<Generated> {
    const schema = z.object(Object.assign({}, ...parts.map(part => PARTS[part].fields)) as Record<keyof Generated, z.ZodType<string>>);
    const overrides = await this.styleOverrides();
    const styles = parts.map(part => {
      const { key, label, text } = PARTS[part].style;
      return `${label}:\n${overrides?.[key]?.instructions?.trim() || text}`;
    });
    const prompt = [task(parts), ...styles, [`Return JSON only with fields ${listFields(Object.keys(schema.shape))}.`, "", ...(await this.changes(baseRef))].join("\n")].join("\n\n");
    const withCommit = parts.includes("commit");
    const generated = await this.generate(prompt, schema, withCommit ? "CommitAndPullRequest" : "PullRequest", withCommit ? "Commit and PR generator" : "PR generator");
    // A placeholder would publish text that says nothing about the changes, so the run stops.
    if (generated === null) throw new Error(`Could not write the ${withCommit ? "commit message and pull request" : "pull request"}: no model in Paseo's metadata generation settings gave a valid answer.`);
    return generated;
  }
  private async styleOverrides(): Promise<StyleOverrides> {
    try {
      const root = await this.repo.git(["rev-parse", "--show-toplevel"]);
      return PaseoConfigSchema.parse(JSON.parse(await readFile(join(root, "paseo.json"), "utf8"))).metadataGeneration;
    } catch {
      this.signal.throwIfAborted();
      return undefined;
    }
  }
  // From the merge base to the index: what the pull request holds once the staged changes are committed.
  private async changes(baseRef: string) {
    const range = ["--cached", await this.repo.git(["merge-base", baseRef, "HEAD"])];
    const [patch, numstat, nameStatus] = await Promise.all([
      this.repo.git(["diff", ...range, "--no-ext-diff"]),
      this.repo.git(["diff", ...range, "--numstat", "-z", "--no-renames"]),
      this.repo.git(["diff", ...range, "--name-status", "-z", "--no-renames"]),
    ]);
    return describeChanges(patch, numstat, nameStatus);
  }

  // Each provider in turn; null when every one failed.
  private async generate<T>(prompt: string, schema: z.ZodType<T>, schemaName: string, title: string): Promise<T | null> {
    this.signal.throwIfAborted();
    const { providers, entries } = await resolveStructuredGenerationProviders(this.paseo, this.repo.directory);
    const outputSchema = { ...z.toJSONSchema(schema, { target: "draft-7", io: "input" }), title: schemaName };
    const basePrompt = [prompt.trim(), "", "You must respond with JSON only that matches this JSON Schema:", JSON.stringify(outputSchema, null, 2)].join("\n");
    // Up to three answers, each retry quoting what was wrong with the last.
    const withRetries = async (ask: (prompt: string, attempt: number) => Promise<string>) => {
      let next = basePrompt;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const result = parseResponse(await ask(next, attempt), schema);
        if (result.ok) return result.value;
        next = [basePrompt, "", "Previous response was invalid with validation errors:", result.errors.map(error => `- ${error}`).join("\n"), "", "Respond again with JSON only that matches the schema."].join("\n");
      }
      return null;
    };
    for (const candidate of providers) {
      this.signal.throwIfAborted();
      const entry = entries.find(entry => entry.provider === candidate.provider);
      if (entry?.status !== "ready") continue;
      // A one-shot `claude -p` with no tools, hooks, MCP servers or slash commands skips the Paseo
      // agent session (about 3 s a call). Without the CLI it falls back to an agent.
      if (candidate.provider === "claude" && candidate.model) {
        const args = ["-p", "--model", candidate.model, "--output-format", "text", "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true })];
        try {
          const value = await withRetries(async input => (await this.repo.run("claude", args, { cwd: this.repo.directory, input, timeout: 120_000, signal: this.signal })).stdout);
          if (value !== null) return value;
          continue;
        } catch (error) {
          this.signal.throwIfAborted();
          if ((error as { code?: unknown }).code !== "ENOENT") continue;
        }
      }
      const config = readOnlyGenerationConfig(candidate, entry);
      if (!config) continue;
      let agent: PaseoAgentHandle | undefined;
      try {
        const value = await withRetries(async (input, attempt) => {
          if (attempt === 0) {
            // In the button's workspace: a daemon-level create opens a new, auto-named workspace.
            agent = await this.paseo.workspaces.ref(this.workspaceId).agents.create({ config, title, prompt: input, outputSchema, labels: { "paseo-pull-request": "generator" } });
          } else await agent!.send(input);
          this.signal.throwIfAborted();
          const response = await this.wait(agent!.waitForFinish(120_000));
          if (response.status !== "idle") throw new Error(response.error ?? `Metadata agent ended with ${response.status}.`);
          return response.lastMessage ?? "";
        });
        if (value !== null) return value;
      } catch { this.signal.throwIfAborted(); }
      finally {
        // Not awaited, so archiving adds no latency; a failure is only logged.
        const created = agent as PaseoAgentHandle | undefined;
        if (created) void created.archive().catch(error => console.error(`Failed to archive metadata agent ${created.id}.`, error));
      }
    }
    this.signal.throwIfAborted();
    return null;
  }
  private async wait(task: Promise<PaseoAgentRunResult>) {
    let aborted!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", aborted, { once: true });
      if (this.signal.aborted) aborted();
    });
    try { return await Promise.race([task, cancellation]); }
    finally { this.signal.removeEventListener("abort", aborted); }
  }
}

// Same fenced/balanced JSON extraction as Paseo's agent-response-loop.
export function extractJsonFromMarkdown(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();
  const source = text.trim();
  for (let start = 0; start < source.length; start++) {
    const open = source[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) { depth++; continue; }
      if (ch !== close || --depth !== 0) continue;
      const candidate = source.slice(start, i + 1);
      try { JSON.parse(candidate); return candidate; } catch { /* Continue searching the response, as upstream does. */ }
    }
  }
  return source;
}
