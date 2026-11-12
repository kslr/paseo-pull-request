// Contracts for the workspace header's Create PR button: the checkout's status, and a run that
// commits, pushes and opens the pull request. A run can take minutes (hooks, generation), so it is
// started and then polled.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { prStateSchema } from "./pullRequest.ts";

const text = z.string().trim().min(1);
const count = z.number().int().nonnegative();
const directory = z.object({ directory: z.string().min(1) });

export const gitStatusSchema = z.object({
  isRepo: z.boolean(),
  // A pull request needs one; the push goes wherever `git push` would.
  hasGitHubRemote: z.boolean(),
  isDefaultRef: z.boolean(),
  refName: text.nullable(),
  hasWorkingTreeChanges: z.boolean(),
  hasUpstream: z.boolean(),
  aheadCount: count,
  behindCount: count,
  aheadOfDefaultCount: count.nullable(),
  pr: z.object({ number: z.number().int().positive(), title: text, url: z.string(), state: prStateSchema }).nullable(),
});

// What a press runs on the checked-out branch: commit any changes and push, then, for
// commit_push_pr, open or create the branch's pull request. On the default branch the button
// commits and pushes; elsewhere, such as a worktree's branch, it creates the pull request.
export const createPullRequestActionSchema = z.enum(["commit_push", "commit_push_pr"]);

const createPullRequestResultSchema = z.object({
  commit: z.object({ sha: text, subject: text }).nullable(),
  // null for commit_push.
  pr: z.object({ status: z.enum(["created", "opened_existing"]), number: z.number().int().positive(), url: z.string(), title: text }).nullable(),
});

export const createPullRequestRunSchema = z.discriminatedUnion("status", [
  // label: progress such as "Pushing..."; lastOutputLine: the latest line a hook or git printed.
  z.object({ status: z.literal("running"), label: text, lastOutputLine: z.string().nullable(), phaseStartedAt: z.number() }),
  z.object({ status: z.literal("succeeded"), result: createPullRequestResultSchema }),
  z.object({ status: z.literal("failed"), message: z.string() }),
]);

// runId is chosen by the client, unique per run; starting the same id twice returns the existing run.
const run = directory.extend({ runId: text.max(128) });

export const gitStatusRpc = defineRpc({ name: "git.status", input: directory, output: gitStatusSchema });
export const startCreatePullRequestRpc = defineRpc({
  name: "git.create-pr.start",
  // The Paseo workspace the button belongs to; generation agents are created in it, since a
  // daemon-level agent would open a new workspace for every generation.
  input: run.extend({ workspaceId: text.max(128), action: createPullRequestActionSchema }),
  output: createPullRequestRunSchema,
});
export const createPullRequestRunRpc = defineRpc({ name: "git.create-pr.run", input: run, output: createPullRequestRunSchema });

export type GitStatus = z.infer<typeof gitStatusSchema>;
export type CreatePullRequestAction = z.infer<typeof createPullRequestActionSchema>;
export type CreatePullRequestResult = z.infer<typeof createPullRequestResultSchema>;
export type CreatePullRequestRun = z.infer<typeof createPullRequestRunSchema>;
