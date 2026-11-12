// A checkout's git commands and the status the Create PR button and a run decide from.
import type { GitStatus } from "../../shared/createPullRequest.ts";
import { GitHub } from "../github.ts";
import type { Remote } from "../github.ts";
import { CommandError, commandFailed, runCommand } from "../process.ts";
import type { Runner } from "../process.ts";

export interface RepositoryStatus {
  status: Omit<GitStatus, "pr">;
  // The remote the default branch comes from: origin, else the first one.
  baseRemote: string | null;
  defaultRef: string | null;
  // Where the default branch is read from: the base remote's copy, else the local branch.
  baseRef: string | null;
}
const NOT_A_REPOSITORY: RepositoryStatus = {
  status: { isRepo: false, hasGitHubRemote: false, isDefaultRef: false, refName: null, hasWorkingTreeChanges: false, hasUpstream: false, aheadCount: 0, behindCount: 0, aheadOfDefaultCount: null },
  baseRemote: null, defaultRef: null, baseRef: null,
};

interface WorkingTree { refName: string | null; unborn: boolean; hasUpstream: boolean; ahead: number; behind: number; hasChanges: boolean }

// `git status --porcelain=v2 --branch -z`: "# branch.<key> <value>" headers, then a record per
// changed or untracked path.
export function parseWorkingTree(raw: string): WorkingTree {
  const headers = new Map<string, string>();
  let hasChanges = false;
  for (const record of raw.split("\0")) {
    const header = /^# branch\.(\S+) ([\s\S]*)$/.exec(record);
    if (header && !headers.has(header[1])) headers.set(header[1], header[2]);
    if (record && !record.startsWith("# ")) hasChanges = true;
  }
  const head = headers.get("head");
  const [, ahead = "0", behind = "0"] = /\+(\d+) -(\d+)/.exec(headers.get("ab") ?? "") ?? [];
  return {
    // A detached HEAD shows as "(detached)".
    refName: head && !head.startsWith("(") ? head : null,
    unborn: headers.get("oid") === "(initial)", hasUpstream: headers.has("upstream"),
    ahead: Number(ahead), behind: Number(behind), hasChanges,
  };
}

export class GitRepository {
  readonly run: Runner;
  readonly directory: string;
  readonly github: GitHub;
  constructor(directory: string, run: Runner = runCommand) { this.directory = directory; this.run = run; this.github = new GitHub(directory, run); }
  async git(args: string[]) { return (await this.run("git", args, { cwd: this.directory })).stdout.trim(); }
  // null when git exits with 1, as it does for a missing ref.
  async optional(args: string[]) {
    return this.git(args).catch((error: unknown) => {
      if (error instanceof CommandError && error.code === 1) return null;
      throw error;
    });
  }

  async readStatus(): Promise<RepositoryStatus> {
    const raw = await this.git(["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "-z"]).catch((error: Error) => {
      if (/not a git repository/i.test(error.message)) return null;
      throw error;
    });
    if (raw === null) return NOT_A_REPOSITORY;
    const tree = parseWorkingTree(raw);
    const remotes = (await this.git(["remote"])).split("\n").filter(Boolean);
    const github = await this.github.remotes();
    const baseRemote = remotes.includes("origin") ? "origin" : remotes[0] ?? null;
    const defaultRef = baseRemote ? await this.defaultBranch(baseRemote, github) : null;
    // Without a known default branch, the usual names stand in for it.
    const isDefaultRef = tree.refName !== null && (defaultRef === null ? ["main", "master"].includes(tree.refName) : tree.refName === defaultRef);
    const baseRef = defaultRef ? await this.firstRef([...(baseRemote ? [`refs/remotes/${baseRemote}/${defaultRef}`] : []), `refs/heads/${defaultRef}`]) : null;
    const aheadOfDefaultCount = isDefaultRef ? 0 : baseRef && !tree.unborn ? Number(await this.git(["rev-list", "--count", `${baseRef}..HEAD`])) : null;
    return {
      status: {
        isRepo: true, hasGitHubRemote: github.length > 0, isDefaultRef, refName: tree.refName, hasWorkingTreeChanges: tree.hasChanges,
        // Without an upstream, everything ahead of the default branch is still to push.
        hasUpstream: tree.hasUpstream, aheadCount: tree.hasUpstream ? tree.ahead : aheadOfDefaultCount ?? 0, behindCount: tree.behind, aheadOfDefaultCount,
      },
      baseRemote, defaultRef, baseRef,
    };
  }

  // The remote's HEAD as last fetched, else what GitHub says for the remote's repository.
  private async defaultBranch(remote: string, github: Remote[]): Promise<string | null> {
    const prefix = `refs/remotes/${remote}/`;
    const remoteHead = await this.optional(["symbolic-ref", "--quiet", `${prefix}HEAD`]);
    if (remoteHead) return remoteHead.slice(prefix.length);
    // Named explicitly: gh on its own would prefer a remote named upstream.
    const repository = github.find(candidate => candidate.name === remote);
    if (!repository) return null;
    try {
      const { stdout } = await this.run("gh", ["repo", "view", `${repository.host}/${repository.repository}`, "--json", "defaultBranchRef"], { cwd: this.directory });
      return (JSON.parse(stdout) as { defaultBranchRef?: { name?: string } | null }).defaultBranchRef?.name ?? null;
    } catch (error) {
      // Offline, or gh missing or signed out: the status goes on without it. A cancelled run does not.
      if (commandFailed(error)) return null;
      throw error;
    }
  }
  private async firstRef(candidates: string[]) {
    for (const ref of candidates) if (await this.optional(["rev-parse", "--verify", "--quiet", ref])) return ref;
    return null;
  }
}
