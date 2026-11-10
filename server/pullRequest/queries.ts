// GitHub GraphQL documents for the pull request panel, passed through gh.
const variables = `$owner:String!,$name:String!,$number:Int!`;
const checkFields = `... on StatusContext { context state targetUrl description isRequired(pullRequestNumber:$number) }
  ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber:$number) checkSuite { workflowRun { workflow { name } } } }`;
export const detailQuery = `query(${variables}) { repository(owner:$owner,name:$name) {
  mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed viewerPermission defaultBranchRef { name }
  pullRequest(number:$number) { number title body url state isDraft mergeable mergeStateStatus reviewDecision additions deletions changedFiles updatedAt mergedAt closedAt
    headRefName baseRefName isCrossRepository headRepository { viewerPermission } headRef { id }
    author { login } autoMergeRequest { mergeMethod } viewerCanUpdate
  }
} }`;
export const checksQuery = `query(${variables},$after:String) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { ${checkFields} } } } } } } } } }`;
// What a write needs to address the pull request and check it is still safe.
export const writeStateQuery = `query(${variables}) { repository(owner:$owner,name:$name) { id defaultBranchRef { name } pullRequest(number:$number) { id state headRefName headRefOid isCrossRepository headRef { target { oid } } isMergeQueueEnabled } } }`;
