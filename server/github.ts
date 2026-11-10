// The workspace's GitHub remote and the gh CLI that talks to it: remote discovery, auth, GraphQL,
// and the pull request of a branch.
import type { UnavailableReason } from "../shared/pullRequest.ts";
import { CommandError, redactError, runCommand } from "./process.ts";
import type { Runner } from "./process.ts";

export interface Remote { name: string; host: string; repository: string }
export interface BranchPullRequest { number: number; url: string; title: string; state: "open" | "closed" | "merged" }

export function parseRemoteUrl(value: string): Omit<Remote, "name"> | null {
  const match = /^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/(?:[^/@]+@)?|git:\/\/)([^/:]+)(?::\d+)?\/([^?#]+)$/.exec(value)
    ?? /^(?:[^@\s]+@)([^:\s]+):(.+)$/.exec(value);
  if (!match) return null;
  const repository = match[2].replace(/\/$/, "").replace(/\.git$/, "");
  const host = match[1].toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some(p => p === "." || p === "..")) return null;
  // Enterprise hosts are confirmed by gh's authenticated API, not by a hostname guess.
  if (["gitlab.com", "bitbucket.org", "codeberg.org"].includes(host)) return null;
  return { host, repository };
}

export class UnavailableError extends Error {
  reason: Exclude<UnavailableReason, "error">;
  constructor(reason: UnavailableError["reason"], message: string) { super(message); this.reason = reason; }
}

const branchPullRequestQuery = `query($owner:String!,$name:String!,$head:String!) { repository(owner:$owner,name:$name) {
  open:pullRequests(first:1,headRefName:$head,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { number url title state } }
  latest:pullRequests(first:1,headRefName:$head,orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { number url title state } }
} }`;

export class GitHub {
  readonly run: Runner;
  constructor(run: Runner = runCommand) { this.run = run; }
  // GitHub remotes, origin first.
  async remotes(directory: string): Promise<Remote[]> {
    let output: string;
    try { output = (await this.run("git", ["remote", "-v"], { cwd: directory })).stdout; }
    catch (error) {
      if (/not a git repository/i.test((error as Error).message)) throw new UnavailableError("not-git", "This directory is not a Git repository.");
      throw error;
    }
    const remotes = output.split("\n").flatMap(line => {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
      const parsed = match && parseRemoteUrl(match[2]);
      return parsed ? [{ name: match[1], ...parsed }] : [];
    });
    return remotes.sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"));
  }
  async remote(directory: string) {
    const remote = (await this.remotes(directory))[0];
    if (!remote) throw new UnavailableError("no-github-remote", "This repository has no GitHub remote.");
    return remote;
  }
  async auth(directory: string, host: string) {
    try { await this.run("gh", ["auth", "status", "--hostname", host], { cwd: directory }); }
    catch (error) {
      if (error instanceof CommandError && error.code === "ENOENT") throw new UnavailableError("gh-missing", "GitHub CLI is not installed on the daemon. Install gh to use pull requests.");
      throw new UnavailableError("gh-unauthenticated", `${(error as Error).message}\nRun gh auth login --hostname ${host} on the daemon.`);
    }
  }
  async graphql<T = any>(directory: string, host: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const args = ["api", "--hostname", host, "graphql", "--method", "POST", "-H", "Accept: application/vnd.github+json", "--input", "-"];
    const { stdout } = await this.run("gh", args, { cwd: directory, input: JSON.stringify({ query, variables }) });
    const result = JSON.parse(stdout) as { data: T; errors?: { message: string }[] };
    if (result.errors?.length) throw new Error(redactError(result.errors.map(e => e.message).join("\n")));
    return result.data;
  }
  // The branch's open pull request, else its most recently updated one.
  async branchPullRequest(directory: string, remote: Remote, branch: string): Promise<BranchPullRequest | null> {
    const [owner, name] = remote.repository.split("/");
    const data = await this.graphql(directory, remote.host, branchPullRequestQuery, { owner, name, head: branch });
    if (!data.repository) throw new Error(`GitHub repository ${remote.repository} was not found.`);
    const pr = data.repository.open.nodes[0] ?? data.repository.latest.nodes[0];
    return pr ? { number: pr.number, url: pr.url, title: pr.title, state: pr.state.toLowerCase() } : null;
  }
}
