// The Create PR steps for one checkout: commit what changed (on a new feature branch when on the
// default branch), push, then open the branch's pull request or create one.
import type { CreatePullRequestResult } from "../../shared/createPullRequest.ts";
import { featureBranchName } from "./branchName.ts";
import type { GitMetadataGenerator, PullRequestText } from "./metadata.ts";
import type { GitRepository, RepositoryStatus } from "./repository.ts";

const succeeds = (task: Promise<unknown>) => task.then(() => true, () => false);

// A default branch that is only behind its remote gives way to the remote's tip, so the pull
// request does not start out of date; the uncommitted changes come along. With local commits on
// it, or changes that collide with the remote's, the branch starts at HEAD.
async function cutFeatureBranch(repo: GitRepository, branch: string, { primary, defaultRef }: RepositoryStatus) {
  const remoteTip = primary && defaultRef ? `refs/remotes/${primary}/${defaultRef}` : null;
  if (remoteTip && (await succeeds(repo.git(["merge-base", "--is-ancestor", "HEAD", remoteTip]))) && (await succeeds(repo.git(["switch", "--quiet", "--no-track", "-c", branch, remoteTip])))) return;
  await repo.git(["checkout", "-b", branch]);
}

export async function createPullRequest(repo: GitRepository, generator: GitMetadataGenerator, phase: (label: string) => void): Promise<CreatePullRequestResult> {
  let initial = await repo.readStatus();
  if (!initial.status.isRepo) throw new Error("This directory is not a Git repository.");
  // Without a background fetch, the base and the PR text's diff would come from whatever was
  // last fetched. Offline, the run goes on with the refs it has.
  if (initial.primary && initial.defaultRef) {
    phase(`Fetching ${initial.defaultRef}...`);
    const refspec = `+refs/heads/${initial.defaultRef}:refs/remotes/${initial.primary}/${initial.defaultRef}`;
    if (await succeeds(repo.git(["fetch", "--quiet", "--no-tags", initial.primary, refspec]))) initial = await repo.readStatus();
  }
  const { status, defaultRef, baseRef } = initial;
  if (!status.refName) throw new Error("Cannot create a pull request from detached HEAD.");
  if (!defaultRef || !baseRef) throw new Error("Cannot resolve the repository's default branch. Fetch it before creating a PR.");
  // A pull request from the default branch into itself cannot exist.
  const onFeatureBranch = status.isDefaultRef;
  let branch = status.refName, text: PullRequestText | null = null, commit: CreatePullRequestResult["commit"] = null;

  await repo.git(["add", "-A"]);
  if (await repo.git(["diff", "--cached", "--name-only", "-z"])) {
    phase("Generating commit message and PR...");
    const generated = await generator.commitAndPullRequest(baseRef, onFeatureBranch);
    text = generated;
    if (onFeatureBranch) {
      branch = featureBranchName((await repo.git(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"])).split("\n"), generated.branch);
      await cutFeatureBranch(repo, branch, initial);
    }
    phase("Committing...");
    await repo.git(["commit", "-m", generated.commitMessage]);
    commit = { sha: await repo.git(["rev-parse", "HEAD"]), subject: generated.commitMessage };
  } else if (onFeatureBranch) throw new Error("Cannot create a feature branch because there are no changes to commit.");

  phase("Pushing...");
  const current = await repo.readStatus();
  if (!current.status.hasUpstream) {
    if (!current.primary) throw new Error("Cannot push because no git remote is configured for this repository.");
    await repo.git(["push", "-u", "--", current.primary, "HEAD"]);
  } else if (current.status.aheadCount > 0) {
    const remote = await repo.git(["config", "--get", `branch.${branch}.remote`]);
    const merge = await repo.git(["config", "--get", `branch.${branch}.merge`]);
    // A branch cut from origin/main publishes its own name rather than overwriting main.
    await repo.git(["push", ...(merge === `refs/heads/${branch}` ? [] : ["-u"]), "--", remote, `HEAD:refs/heads/${branch}`]);
  }

  const remote = await repo.github.remote(repo.directory);
  const existing = await repo.github.branchPullRequest(repo.directory, remote, branch);
  const created = onFeatureBranch ? branch : null;
  if (existing?.state === "open") return { branch: created, commit, pr: { status: "opened_existing", number: existing.number, url: existing.url, title: existing.title } };
  if (!text) {
    phase("Generating PR...");
    text = await generator.pullRequest(baseRef);
  }
  phase("Creating pull request...");
  // --repo names the repository branchPullRequest searched: without it gh prefers a remote named
  // upstream, and a checkout pushed to origin opened its pull request there.
  const output = (await repo.run("gh", ["pr", "create", "--repo", `${remote.host}/${remote.repository}`, "--base", defaultRef, "--head", branch, "--title", text.title, "--body-file", "-"], { cwd: repo.directory, input: text.body })).stdout.trim();
  const url = output.split(/\r?\n/).at(-1)!, number = /\/pull\/(\d+)$/.exec(url)?.[1];
  if (!number) throw new Error(`GitHub CLI did not return a pull request URL: ${output}`);
  return { branch: created, commit, pr: { status: "created", number: Number(number), url, title: text.title } };
}
