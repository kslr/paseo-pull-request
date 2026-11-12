// The Create PR steps for one checkout: refresh the default branch, commit what changed on the
// checked-out branch, push it, then open the branch's pull request or create one. The run never
// creates or switches branches, so the workspace stays on the branch it is working on.
import type { CreatePullRequestResult } from "../../shared/createPullRequest.ts";
import type { GitMetadataGenerator, PullRequestText } from "./metadata.ts";
import type { GitRepository } from "./repository.ts";

type Phase = (label: string) => void;
interface Plan { branch: string; defaultRef: string; baseRef: string }
interface Committed { commit: CreatePullRequestResult["commit"]; text: PullRequestText | null }

const succeeds = (task: Promise<unknown>) => task.then(() => true, () => false);

async function prepare(repo: GitRepository, phase: Phase): Promise<Plan> {
  let start = await repo.readStatus();
  if (!start.status.isRepo) throw new Error("This directory is not a Git repository.");
  // Otherwise the base and the diff the PR text is written from are whatever was last fetched.
  // Offline, the run goes on with the refs it has.
  if (start.baseRemote && start.defaultRef) {
    phase(`Fetching ${start.defaultRef}...`);
    const refspec = `+refs/heads/${start.defaultRef}:refs/remotes/${start.baseRemote}/${start.defaultRef}`;
    if (await succeeds(repo.git(["fetch", "--quiet", "--no-tags", start.baseRemote, refspec]))) start = await repo.readStatus();
  }
  const { status: { refName, isDefaultRef }, defaultRef, baseRef } = start;
  if (!refName) throw new Error("Cannot create a pull request from detached HEAD.");
  if (!defaultRef || !baseRef) throw new Error("Cannot resolve the repository's default branch. Fetch it before creating a PR.");
  // A pull request from the default branch into itself cannot exist.
  if (isDefaultRef) throw new Error(`Cannot create a pull request from the default branch ${refName}. Create a branch first.`);
  return { branch: refName, defaultRef, baseRef };
}

async function commitChanges(repo: GitRepository, generator: GitMetadataGenerator, phase: Phase, plan: Plan): Promise<Committed> {
  await repo.git(["add", "-A"]);
  if (!(await repo.git(["diff", "--cached", "--name-only", "-z"]))) return { commit: null, text: null };
  // From everything the pull request will hold.
  phase("Generating commit message and PR...");
  const { commitMessage, title, body } = await generator.commitAndPullRequest(plan.baseRef);
  phase("Committing...");
  await repo.git(["commit", "-m", commitMessage]);
  return { commit: { sha: await repo.git(["rev-parse", "HEAD"]), subject: commitMessage }, text: { title, body } };
}

// To the remote `git push` would choose, as the user configured git, under the branch's own name:
// a branch tracking another, such as one created from origin/main, does not overwrite it. A branch
// without an upstream gets the pushed one.
const push = (repo: GitRepository) => repo.git(["-c", "push.default=current", "-c", "push.autoSetupRemote=true", "push"]);

// gh prints the new pull request's URL as its last line.
export function parseCreatedPullRequest(output: string) {
  const url = output.trim().split(/\r?\n/).pop() ?? "", number = /\/pull\/(\d+)$/.exec(url)?.[1];
  if (!number) throw new Error(`GitHub CLI did not return a pull request URL: ${output.trim()}`);
  return { number: Number(number), url };
}

async function propose(repo: GitRepository, generator: GitMetadataGenerator, phase: Phase, plan: Plan, committed: Committed): Promise<CreatePullRequestResult["pr"]> {
  const remote = await repo.github.remote();
  const existing = await repo.github.branchPullRequest(remote, plan.branch);
  if (existing?.state === "open") return { status: "opened_existing", number: existing.number, url: existing.url, title: existing.title };
  let text = committed.text;
  if (!text) {
    phase("Generating PR...");
    text = await generator.pullRequest(plan.baseRef);
  }
  phase("Creating pull request...");
  // --repo is the repository branchPullRequest searched: on its own, gh prefers a remote named
  // upstream, and would open the pull request there for a checkout pushed to origin.
  const args = ["pr", "create", "--repo", `${remote.host}/${remote.repository}`, "--base", plan.defaultRef, "--head", plan.branch, "--title", text.title, "--body-file", "-"];
  const { stdout } = await repo.run("gh", args, { cwd: repo.directory, input: text.body });
  return { status: "created", ...parseCreatedPullRequest(stdout), title: text.title };
}

export async function createPullRequest(repo: GitRepository, generator: GitMetadataGenerator, phase: Phase): Promise<CreatePullRequestResult> {
  const plan = await prepare(repo, phase);
  const committed = await commitChanges(repo, generator, phase, plan);
  phase("Pushing...");
  await push(repo);
  const pr = await propose(repo, generator, phase, plan, committed);
  return { commit: committed.commit, pr };
}
