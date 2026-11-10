// A PaseoApi double for generation tests: records created, retried and archived agents.
import type { PaseoApi, PaseoAgentCreateOptions, PaseoAgentRunResult } from "@getpaseo/client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
export function fakePaseo(generate: (input: Omit<PaseoAgentCreateOptions, "cwd"> & { workspaceId: string }, attempt: number) => unknown | Promise<unknown> = () => ({ commitMessage: "Update files", title: "Update", body: "Body", branch: "update" }), options: { providers?: { provider: string; model?: string; thinkingOptionId?: string }[]; entries?: ProviderSnapshotEntry[]; createError?: boolean; archiveError?: boolean; archive?: (id: number) => Promise<void> } = {}) {
  const created: (Omit<PaseoAgentCreateOptions, "cwd"> & { workspaceId: string })[] = [], archived: number[] = [], retries: string[] = [];
  const entries: ProviderSnapshotEntry[] = options.entries ?? [{ provider: "codex", status: "ready", enabled: true, models: [{ provider: "codex", id: "gpt-5.4-mini", label: "GPT mini", thinkingOptions: [{ id: "low", label: "Low" }] }] }];
  const paseo = {
    config: { get: async () => ({ config: { metadataGeneration: { providers: options.providers ?? [] } } }) },
    providers: { snapshot: async () => ({ entries }) },
    // A daemon-level create opens a new workspace; generation must use the workspace's handle.
    agents: { create: async () => { throw new Error("Metadata agents must be created in the button's workspace."); } },
    workspaces: { ref: (workspaceId: string) => ({ agents: { create: async (createOptions: Omit<PaseoAgentCreateOptions, "cwd">) => {
      const input = { ...createOptions, workspaceId };
      const id = created.push(input); let attempt = 0;
      if (options.createError) throw new Error("Agent creation failed");
      return {
        id: String(id),
        waitForFinish: async (): Promise<PaseoAgentRunResult> => {
          const value = await generate(input, attempt++);
          if (value && typeof value === "object" && "status" in value) return value as PaseoAgentRunResult;
          return { status: "idle", final: null, error: null, lastMessage: typeof value === "string" ? value : JSON.stringify(value) };
        },
        send: async (prompt: string) => { retries.push(prompt); },
        archive: async () => { archived.push(id); await options.archive?.(id); if (options.archiveError) throw new Error("Archive failed"); return { archivedAt: new Date().toISOString() }; },
      };
    } } }) },
  } as unknown as PaseoApi;
  return { paseo, created, archived, retries };
}
