// The GraphQL mutation behind each panel write, planned from the pull request's current state, with
// the checks a write must pass before anything is sent.
import type { ActionInput, MergeMethod } from "../../shared/pullRequest.ts";
import type { WriteRepository } from "./queries.ts";

type WriteTarget = WriteRepository & { pullRequest: NonNullable<WriteRepository["pullRequest"]> };
type WritablePullRequest = WriteTarget["pullRequest"];
export interface Mutation { query: string; variables: { input: Record<string, unknown> } }

// A mutation taking GitHub's conventional single `input` argument of type <Field>Input.
const mutation = (field: string, input: Record<string, unknown>): Mutation => ({
  query: `mutation($input:${field[0].toUpperCase()}${field.slice(1)}Input!) { ${field}(input:$input) { clientMutationId } }`,
  variables: { input },
});

const STATE_MUTATIONS = {
  "disable-auto-merge": "disablePullRequestAutoMerge", ready: "markPullRequestReadyForReview", draft: "convertPullRequestToDraft",
  close: "closePullRequest", reopen: "reopenPullRequest",
} as const;
// updateRefs deletes a ref by moving it to the null object id.
const DELETED = "0".repeat(40);

function merge(pr: WritablePullRequest, viaAutoMerge: boolean, method: MergeMethod): Mutation {
  const input = { pullRequestId: pr.id, mergeMethod: method.toUpperCase() };
  // A merge queue takes merges only through auto-merge.
  if (viaAutoMerge || pr.isMergeQueueEnabled === true) return mutation("enablePullRequestAutoMerge", input);
  // GitHub refuses the merge if the head moved after the viewer last saw it.
  return mutation("mergePullRequest", { ...input, expectedHeadOid: pr.headRefOid });
}

// Only this pull request's own branch, once the pull request is done with it, and only while it
// still points at the pull request's head.
function deleteBranch({ id, defaultBranchRef, pullRequest: pr }: WriteTarget): Mutation {
  if (pr.isCrossRepository) throw new Error("Branches from fork pull requests cannot be deleted here.");
  if (pr.state === "OPEN") throw new Error("Close or merge the pull request before deleting its branch.");
  if (pr.headRefName === defaultBranchRef?.name) throw new Error("The repository's default branch cannot be deleted.");
  if (!pr.headRef) throw new Error("The pull request branch no longer exists.");
  const tip = pr.headRef.target.oid;
  if (tip !== pr.headRefOid) throw new Error("The branch has new commits since this pull request. It cannot be deleted here.");
  // beforeOid makes the deletion fail if the branch moves before GitHub applies it.
  return mutation("updateRefs", { repositoryId: id, refUpdates: [{ name: `refs/heads/${pr.headRefName}`, beforeOid: tip, afterOid: DELETED }] });
}

export function actionMutation(request: ActionInput, target: WriteTarget): Mutation {
  switch (request.action) {
    case "merge": return merge(target.pullRequest, false, request.mergeMethod);
    case "enable-auto-merge": return merge(target.pullRequest, true, request.mergeMethod);
    case "delete-branch": return deleteBranch(target);
    default: return mutation(STATE_MUTATIONS[request.action], { pullRequestId: target.pullRequest.id });
  }
}

// Only the fields given change; an empty body clears it.
export function updateMutation({ pullRequest }: WriteTarget, fields: { title?: string; body?: string }): Mutation {
  const input: Record<string, unknown> = { pullRequestId: pullRequest.id };
  if (fields.title !== undefined) input.title = fields.title;
  if (fields.body !== undefined) input.body = fields.body;
  return mutation("updatePullRequest", input);
}
