// GitHub GraphQL documents for the pull request panel, and the parts of their answers it reads.
// Every document addresses one pull request through $owner, $name and $number.
import { repositoryQuery } from "../github.ts";

const pullRequestQuery = (repositoryFields: string[], pullRequestFields: string[], variables: Record<string, string> = {}) =>
  repositoryQuery({ number: "Int!", ...variables }, [...repositoryFields, `pullRequest(number:$number) { ${pullRequestFields.join(" ")} }`].join(" "));

type Nullable<T> = T | null;
export interface DetailRepository {
  viewerPermission: Nullable<string>; defaultBranchRef: Nullable<{ name: string }>;
  mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean; autoMergeAllowed: boolean;
  pullRequest: Nullable<DetailPullRequest>;
}
export interface DetailPullRequest {
  number: number; url: string; title: string; body: string; author: Nullable<{ login: string }>;
  state: string; isDraft: boolean; mergeable: string; mergeStateStatus: Nullable<string>; reviewDecision: Nullable<string>;
  additions: number; deletions: number; changedFiles: number; updatedAt: string; mergedAt: Nullable<string>; closedAt: Nullable<string>;
  headRefName: string; baseRefName: string; isCrossRepository: boolean;
  headRef: Nullable<{ id: string }>; headRepository: Nullable<{ viewerPermission: Nullable<string> }>;
  autoMergeRequest: Nullable<{ mergeMethod: string }>; viewerCanUpdate: boolean;
}
export const detailQuery = pullRequestQuery(
  ["viewerPermission", "defaultBranchRef { name }", "mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed"],
  [
    "number url title body author { login } state isDraft mergeable mergeStateStatus reviewDecision",
    "additions deletions changedFiles updatedAt mergedAt closedAt",
    "headRefName baseRefName isCrossRepository headRef { id } headRepository { viewerPermission }",
    "autoMergeRequest { mergeMethod } viewerCanUpdate",
  ],
);

// The head commit's rollup mixes commit statuses (StatusContext) and Actions or app check runs.
export interface StatusContextNode { context: string; state?: string; targetUrl?: Nullable<string>; description?: Nullable<string>; isRequired?: Nullable<boolean> }
export interface CheckRunNode {
  name: string; status?: string; conclusion?: Nullable<string>; detailsUrl?: Nullable<string>; isRequired?: Nullable<boolean>;
  checkSuite?: Nullable<{ workflowRun: Nullable<{ workflow: Nullable<{ name: string }> }> }>;
}
export interface RollupPage { pageInfo: { hasNextPage: boolean; endCursor: Nullable<string> }; nodes: (StatusContextNode | CheckRunNode)[] }
export interface ChecksRepository { pullRequest: Nullable<{ commits: { nodes: { commit: { statusCheckRollup: Nullable<{ contexts: RollupPage }> } }[] } }> }
const rollupNode = [
  "... on StatusContext { context state targetUrl description isRequired(pullRequestNumber:$number) }",
  "... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber:$number) checkSuite { workflowRun { workflow { name } } } }",
].join(" ");
export const checksQuery = pullRequestQuery([], [
  `commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { ${rollupNode} } } } } } }`,
], { after: "String" });

// What a write needs to address the pull request and to check that it is still safe.
export interface WriteRepository {
  id: string; defaultBranchRef: Nullable<{ name: string }>;
  pullRequest: Nullable<{ id: string; state: string; isCrossRepository: boolean; isMergeQueueEnabled: boolean; headRefName: string; headRefOid: string; headRef: Nullable<{ target: { oid: string } }> }>;
}
export const writeStateQuery = pullRequestQuery(["id", "defaultBranchRef { name }"], ["id state isCrossRepository isMergeQueueEnabled headRefName headRefOid headRef { target { oid } }"]);
