// The Create PR steps for one checkout: refresh the default branch, commit what changed (on a new
// feature branch when the checkout is on the default branch), push, then open the branch's pull
// request or create one.
import type { CreatePullRequestResult } from "../../shared/createPullRequest.ts";
import { featureBranchName } from "./branchName.ts";
import type { GitMetadataGenerator, PullRequestText } from "./metadata.ts";
import type { GitRepository, RepositoryStatus } from "./repository.ts";

type Phase = (label: string) => void;
interface Plan { start: RepositoryStatus; branch: string; defaultRef: string; baseRef: string; cutsBranch: boolean }
interface Committed { branch: string; commit: CreatePullRequestResult["commit"]; text: PullRequestText | null }

const succeeds = (task: Promise<unknown>) => task.then(() => true, () => false);

async function prepare(repo: GitRepository, phase: Phase): Promise<Plan> {
  let start = await repo.readStatus();
  if (!start.status.isRepo) throw new Error("This directory is not a Git repository.");
  // Otherwise the base and the diff the PR text is written from are whatever was last fetched.
  // Offline, the run goes on with the refs it has.
  if (start.primary && start.defaultRef) {
    phase(`Fetching ${start.defaultRef}...`);
    const refspec = `+refs/heads/${start.defaultRef}:refs/remotes/${start.primary}/${start.defaultRef}`;
    if (await succeeds(repo.git(["fetch", "--quiet", "--no-tags", start.primary, refspec]))) start = await repo.readStatus();
  }
  const { status: { refName, isDefaultRef }, defaultRef, baseRef } = start;
  if (!refName) throw new Error("Cannot create a pull request from detached HEAD.");
  if (!defaultRef || !baseRef) throw new Error("Cannot resolve the repository's default branch. Fetch it before creating a PR.");
  // A pull request from the default branch into itself cannot exist, so the commit gets a branch of its own.
  return { start, branch: refName, defaultRef, baseRef, cutsBranch: isDefaultRef };
}

// The new branch starts at the remote's default branch when the local one is only behind it, so
// the pull request does not start out of date; the uncommitted changes come along. With local
// commits, or changes that collide with the remote's, it starts at HEAD.
async function cutFeatureBranch(repo: GitRepository, { primary, defaultRef }: RepositoryStatus, preferred?: string) {
  const branch = featureBranchName((await repo.git(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"])).split("\n"), preferred);
  const remoteTip = primary && defaultRef ? `refs/remotes/${primary}/${defaultRef}` : null;
  const startedAtRemote = remoteTip !== null
    && await succeeds(repo.git(["merge-base", "--is-ancestor", "HEAD", remoteTip]))
    && await succeeds(repo.git(["switch", "--quiet", "--no-track", "-c", branch, remoteTip]));
  if (!startedAtRemote) await repo.git(["checkout", "-b", branch]);
  return branch;
}

async function commitChanges(repo: GitRepository, generator: GitMetadataGenerator, phase: Phase, plan: Plan): Promise<Committed> {
  await repo.git(["add", "-A"]);
  if (!(await repo.git(["diff", "--cached", "--name-only", "-z"]))) {
    if (plan.cutsBranch) throw new Error("Cannot create a feature branch because there are no changes to commit.");
    return { branch: plan.branch, commit: null, text: null };
  }
  // Generated before the branch is cut, from everything the pull request will hold.
  phase("Generating commit message and PR...");
  const { commitMessage, title, body, branch: preferred } = await generator.commitAndPullRequest(plan.baseRef, plan.cutsBranch);
  const branch = plan.cutsBranch ? await cutFeatureBranch(repo, plan.start, preferred) : plan.branch;
  phase("Committing...");
  await repo.git(["commit", "-m", commitMessage]);
  return { branch, commit: { sha: await repo.git(["rev-parse", "HEAD"]), subject: commitMessage }, text: { title, body } };
}

// HEAD goes to the remote branch of the same name. A branch tracking another name, such as one cut
// from origin/main, is published under its own name rather than overwriting that one.
async function push(repo: GitRepository, branch: string) {
  const { status, primary } = await repo.readStatus();
  if (!status.hasUpstream) {
    if (!primary) throw new Error("Cannot push because no git remote is configured for this repository.");
    await repo.git(["push", "-u", "--", primary, "HEAD"]);
    return;
  }
  if (status.aheadCount === 0) return;
  const remote = await repo.git(["config", "--get", `branch.${branch}.remote`]);
  const tracksOwnName = (await repo.git(["config", "--get", `branch.${branch}.merge`])) === `refs/heads/${branch}`;
  await repo.git(["push", ...(tracksOwnName ? [] : ["-u"]), "--", remote, `HEAD:refs/heads/${branch}`]);
}

// gh prints the new pull request's URL as its last line.
export function parseCreatedPullRequest(output: string) {
  const url = output.trim().split(/\r?\n/).pop() ?? "", number = /\/pull\/(\d+)$/.exec(url)?.[1];
  if (!number) throw new Error(`GitHub CLI did not return a pull request URL: ${output.trim()}`);
  return { number: Number(number), url };
}

async function propose(repo: GitRepository, generator: GitMetadataGenerator, phase: Phase, plan: Plan, committed: Committed): Promise<CreatePullRequestResult["pr"]> {
  const remote = await repo.github.remote(repo.directory);
  const existing = await repo.github.branchPullRequest(repo.directory, remote, committed.branch);
  if (existing?.state === "open") return { status: "opened_existing", number: existing.number, url: existing.url, title: existing.title };
  let text = committed.text;
  if (!text) {
    phase("Generating PR...");
    text = await generator.pullRequest(plan.baseRef);
  }
  phase("Creating pull request...");
  // --repo is the repository branchPullRequest searched: on its own, gh prefers a remote named
  // upstream, and would open the pull request there for a checkout pushed to origin.
  const args = ["pr", "create", "--repo", `${remote.host}/${remote.repository}`, "--base", plan.defaultRef, "--head", committed.branch, "--title", text.title, "--body-file", "-"];
  const { stdout } = await repo.run("gh", args, { cwd: repo.directory, input: text.body });
  return { status: "created", ...parseCreatedPullRequest(stdout), title: text.title };
}

export async function createPullRequest(repo: GitRepository, generator: GitMetadataGenerator, phase: Phase): Promise<CreatePullRequestResult> {
  const plan = await prepare(repo, phase);
  const committed = await commitChanges(repo, generator, phase, plan);
  phase("Pushing...");
  await push(repo, committed.branch);
  const pr = await propose(repo, generator, phase, plan, committed);
  return { branch: plan.cutsBranch ? committed.branch : null, commit: committed.commit, pr };
}
