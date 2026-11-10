// A checkout's git commands and the status the Create PR button decides from.
import type { GitStatus } from "../../shared/createPullRequest.ts";
import { GitHub } from "../github.ts";
import { CommandError, runCommand } from "../process.ts";
import type { Runner } from "../process.ts";

export interface RepositoryStatus {
  status: Omit<GitStatus, "pr">;
  // The remote pushes go to: origin, else the first one.
  primary: string | null;
  defaultRef: string | null;
  // Where the default branch is read from: the primary remote's copy, else the local branch.
  baseRef: string | null;
}
const NOT_A_REPOSITORY: RepositoryStatus = {
  status: { isRepo: false, hasPrimaryRemote: false, isDefaultRef: false, refName: null, hasWorkingTreeChanges: false, hasUpstream: false, aheadCount: 0, behindCount: 0, aheadOfDefaultCount: null },
  primary: null, defaultRef: null, baseRef: null,
};

export class GitRepository {
  readonly run: Runner;
  readonly directory: string;
  readonly github: GitHub;
  constructor(directory: string, run: Runner = runCommand) { this.directory = directory; this.run = run; this.github = new GitHub(run); }
  async git(args: string[]) { return (await this.run("git", args, { cwd: this.directory })).stdout.trim(); }
  // null when git exits with 1, as it does for a missing ref.
  async optional(args: string[]) {
    try { return await this.git(args); }
    catch (error) { if (error instanceof CommandError && error.code === 1) return null; throw error; }
  }
  async readStatus(): Promise<RepositoryStatus> {
    let raw: string;
    try { raw = await this.git(["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "-z"]); }
    catch (error) {
      if (/not a git repository/i.test((error as Error).message)) return NOT_A_REPOSITORY;
      throw error;
    }
    const records = raw.split("\0");
    const header = (key: string) => records.find(record => record.startsWith(`# branch.${key} `))?.slice(`# branch.${key} `.length) ?? null;
    const head = header("head"), hasUpstream = header("upstream") !== null, unborn = header("oid") === "(initial)";
    const refName = head && !head.startsWith("(") ? head : null;
    const [, ahead = "0", behind = "0"] = /\+(\d+) -(\d+)/.exec(header("ab") ?? "") ?? [];
    const names = (await this.git(["remote"])).split("\n").filter(Boolean), primary = names.includes("origin") ? "origin" : names[0] ?? null;
    let defaultRef: string | null = null;
    if (primary) {
      defaultRef = (await this.optional(["symbolic-ref", "--quiet", `refs/remotes/${primary}/HEAD`]))?.slice(`refs/remotes/${primary}/`.length) ?? null;
      // Without a remote HEAD, ask GitHub about the primary remote: gh itself would prefer a remote named upstream.
      const github = defaultRef ? undefined : (await this.github.remotes(this.directory)).find(remote => remote.name === primary);
      if (github) {
        try { defaultRef = JSON.parse((await this.run("gh", ["repo", "view", `${github.host}/${github.repository}`, "--json", "defaultBranchRef"], { cwd: this.directory })).stdout).defaultBranchRef?.name ?? null; }
        catch (error) { if (!(error instanceof CommandError) || error.code === "ABORT_ERR") throw error; }
      }
    }
    const isDefaultRef = refName !== null && (refName === defaultRef || (defaultRef === null && ["main", "master"].includes(refName)));
    let baseRef: string | null = null;
    for (const candidate of defaultRef ? [...(primary ? [`refs/remotes/${primary}/${defaultRef}`] : []), `refs/heads/${defaultRef}`] : []) {
      if (await this.optional(["rev-parse", "--verify", "--quiet", candidate])) { baseRef = candidate; break; }
    }
    const aheadOfDefaultCount = isDefaultRef ? 0 : baseRef && !unborn ? Number(await this.git(["rev-list", "--count", `${baseRef}..HEAD`])) : null;
    return {
      status: {
        isRepo: true, hasPrimaryRemote: names.includes("origin"), isDefaultRef, refName,
        hasWorkingTreeChanges: records.some(record => record !== "" && !record.startsWith("# ")),
        // Without an upstream, everything ahead of the default branch is still to push.
        hasUpstream, aheadCount: hasUpstream ? Number(ahead) : aheadOfDefaultCount ?? 0, behindCount: Number(behind), aheadOfDefaultCount,
      },
      primary, defaultRef, baseRef,
    };
  }
}
