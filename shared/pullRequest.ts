// Directory-scoped Zod contracts and RPCs for the pull request panel.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const text = z.string();
const nullableText = text.nullable();
const count = z.number().int().nonnegative();
const prNumber = z.number().int().positive();
export const repositorySchema = text.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(v => v.split("/").every(p => p !== "." && p !== ".."));
export const prStateSchema = z.enum(["open", "closed", "merged"]);
const prRefSchema = z.object({ directory: text.min(1), repository: repositorySchema, number: prNumber });
const checkStatusSchema = z.enum(["pending", "action-required", "success", "failure", "skipped", "neutral", "cancelled"]);
const checkSchema = z.object({ name: text, status: checkStatusSchema, description: nullableText, url: nullableText, required: z.boolean().nullable(), workflowName: nullableText });
const mergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
const mergeActionSchema = z.enum(["merge", "enable-auto-merge"]);
const stateActionSchema = z.enum(["disable-auto-merge", "ready", "draft", "close", "reopen", "delete-branch"]);
export const actionSchema = z.enum([...mergeActionSchema.options, ...stateActionSchema.options]);
const unavailableReasonSchema = z.enum(["not-git", "no-github-remote", "gh-missing", "gh-unauthenticated", "error"]);
const resolveResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), repository: repositorySchema, number: prNumber }),
  z.object({ status: z.literal("none"), repository: repositorySchema.nullable(), branch: nullableText }),
  z.object({ status: z.literal("unavailable"), reason: unavailableReasonSchema, message: text }),
]);
export const detailSchema = z.object({
  repository: repositorySchema, number: prNumber, url: text, title: text, body: text,
  author: z.object({ login: text }).nullable(), state: prStateSchema, isDraft: z.boolean(),
  mergeability: z.enum(["mergeable", "conflicting", "unknown"]), mergeStateStatus: nullableText,
  reviewDecision: z.enum(["approved", "changes-requested", "review-required"]).nullable(),
  additions: count, deletions: count, changedFiles: count, headBranch: text, baseBranch: text,
  updatedAt: text, mergedAt: nullableText, closedAt: nullableText,
  mergeCapabilities: z.object({ merge: z.boolean(), squash: z.boolean(), rebase: z.boolean() }),
  autoMergeAllowed: z.boolean(), autoMergeEnabled: z.boolean(), autoMergeMethod: mergeMethodSchema.nullable(),
  permissions: z.object({ actions: z.array(actionSchema), editChangeRequest: z.boolean() }),
});
const ok = z.object({ ok: z.literal(true) });
const directorySchema = prRefSchema.pick({ directory: true });
export const resolveRpc = defineRpc({ name: "pr.resolve", input: directorySchema, output: resolveResultSchema });
export const detailRpc = defineRpc({ name: "pr.detail", input: prRefSchema, output: detailSchema });
export const checksRpc = defineRpc({ name: "pr.checks", input: prRefSchema, output: z.object({ checks: z.array(checkSchema) }) });
// Merging needs a method; nothing else takes one.
const mergeRequest = { action: mergeActionSchema, mergeMethod: mergeMethodSchema };
const stateRequest = { action: stateActionSchema };
export const actionRpc = defineRpc({ name: "pr.action", input: z.discriminatedUnion("action", [prRefSchema.extend(mergeRequest), prRefSchema.extend(stateRequest)]), output: ok });
export const updateRpc = defineRpc({
  name: "pr.update",
  input: prRefSchema.extend({ title: text.trim().min(1).max(1024).optional(), body: text.max(65536).optional() }).refine(v => v.title !== undefined || v.body !== undefined, "Nothing was changed."),
  output: ok,
});
export const refreshRpc = defineRpc({ name: "pr.refresh", input: prRefSchema, output: ok });
export type PrRef = z.infer<typeof prRefSchema>;
export type Check = z.infer<typeof checkSchema>;
export type CheckStatus = Check["status"];
export type MergeMethod = z.infer<typeof mergeMethodSchema>;
export type Action = z.infer<typeof actionSchema>;
export type ActionInput = z.infer<typeof actionRpc.input>;
export type UpdateInput = z.infer<typeof updateRpc.input>;
export type ActionRequest = z.infer<z.ZodObject<typeof mergeRequest>> | z.infer<z.ZodObject<typeof stateRequest>>;
export type ResolveResult = z.infer<typeof resolveResultSchema>;
export type UnavailableReason = z.infer<typeof unavailableReasonSchema>;
export type Detail = z.infer<typeof detailSchema>;
