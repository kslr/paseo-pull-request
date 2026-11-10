// A checkout's GitHub side through the gh CLI: which remotes point at GitHub, whether gh can reach
// the host, GraphQL queries scoped to one repository, and the pull request of a branch.
import type { GitStatus } from "../shared/createPullRequest.ts";
import { repositorySchema } from "../shared/pullRequest.ts";
import type { UnavailableReason } from "../shared/pullRequest.ts";
import { CommandError, redactError, runCommand } from "./process.ts";
import type { Runner } from "./process.ts";

export interface Remote { name: string; host: string; repository: string }
type Repository = Omit<Remote, "name">;
type BranchPullRequest = NonNullable<GitStatus["pr"]>;

export class UnavailableError extends Error {
  reason: Exclude<UnavailableReason, "error">;
  constructor(reason: UnavailableError["reason"], message: string) { super(message); this.reason = reason; }
}

// Hosts known not to be GitHub. Anything else may be GitHub Enterprise; gh's API decides.
const OTHER_FORGES = new Set(["gitlab.com", "bitbucket.org", "codeberg.org"]);
const URL_REMOTE = /^(https?|ssh|git):\/\/([^/]*)\/([\s\S]*)$/;
const SCP_REMOTE = /^[^@\s]+@([^:\s]+):(.+)$/;
const HOST_AND_PORT = /^([^/:]+)(?::\d+)?$/;

// scheme://[user@]host[:port]/path. git:// carries no user. null when the value is not URL-shaped,
// so that it can still be read as scp-style.
function urlTarget(value: string) {
  const match = URL_REMOTE.exec(value);
  if (!match || !match[3] || /[?#]/.test(match[3])) return null;
  const [, scheme, authority, path] = match, at = authority.indexOf("@");
  const afterUser = scheme !== "git" && at > 0 ? authority.slice(at + 1) : null;
  const host = HOST_AND_PORT.exec(afterUser !== null && HOST_AND_PORT.test(afterUser) ? afterUser : authority)?.[1];
  return host ? { host, path } : null;
}

export function parseRemoteUrl(value: string): Repository | null {
  const scp = SCP_REMOTE.exec(value);
  const target = urlTarget(value) ?? (scp && { host: scp[1], path: scp[2] });
  if (!target) return null;
  const host = target.host.toLowerCase(), repository = target.path.replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || OTHER_FORGES.has(host) || !repositorySchema.safeParse(repository).success) return null;
  return { host, repository };
}

// `git remote -v` fetch lines that point at GitHub, origin first.
export function parseRemotes(output: string): Remote[] {
  const remotes: Remote[] = [];
  for (const line of output.split("\n")) {
    const fields = line.split(/\s+/);
    const target = fields.length === 3 && fields[2] === "(fetch)" ? parseRemoteUrl(fields[1]) : null;
    if (target) remotes.push({ name: fields[0], ...target });
  }
  return [...remotes.filter(remote => remote.name === "origin"), ...remotes.filter(remote => remote.name !== "origin")];
}

// A query over repository(owner:$owner, name:$name), declaring those two and the given variables.
export function repositoryQuery(variables: Record<string, string>, selection: string) {
  const declared = Object.entries({ owner: "String!", name: "String!", ...variables }).map(([name, type]) => `$${name}:${type}`);
  return `query(${declared.join(",")}) { repository(owner:$owner,name:$name) { ${selection} } }`;
}

// The two newest pull requests of a branch: its open one, and any.
const branchPullRequests = (alias: string, filter: string) =>
  `${alias}:pullRequests(first:1,headRefName:$head,${filter}orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { number url title state } }`;
const branchQuery = repositoryQuery({ head: "String!" }, `${branchPullRequests("open", "states:OPEN,")} ${branchPullRequests("latest", "")}`);
type BranchNode = Omit<BranchPullRequest, "state"> & { state: string };

export class GitHub {
  readonly directory: string;
  readonly run: Runner;
  constructor(directory: string, run: Runner = runCommand) { this.directory = directory; this.run = run; }

  async remotes(): Promise<Remote[]> {
    const listed = await this.run("git", ["remote", "-v"], { cwd: this.directory }).catch((error: Error) => {
      throw /not a git repository/i.test(error.message) ? new UnavailableError("not-git", "This directory is not a Git repository.") : error;
    });
    return parseRemotes(listed.stdout);
  }
  async remote(): Promise<Remote> {
    const [first] = await this.remotes();
    if (!first) throw new UnavailableError("no-github-remote", "This repository has no GitHub remote.");
    return first;
  }
  async auth(host: string) {
    await this.run("gh", ["auth", "status", "--hostname", host], { cwd: this.directory }).catch((error: Error) => {
      if (error instanceof CommandError && error.code === "ENOENT") throw new UnavailableError("gh-missing", "GitHub CLI is not installed on the daemon. Install gh to use pull requests.");
      throw new UnavailableError("gh-unauthenticated", `${error.message}\nRun gh auth login --hostname ${host} on the daemon.`);
    });
  }
  // The request goes through stdin, so no field value ever becomes a command-line argument.
  async graphql<T = unknown>(host: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const args = ["api", "--hostname", host, "graphql", "--method", "POST", "-H", "Accept: application/vnd.github+json", "--input", "-"];
    const { stdout } = await this.run("gh", args, { cwd: this.directory, input: JSON.stringify({ query, variables }) });
    const { data, errors } = JSON.parse(stdout) as { data: T; errors?: { message: string }[] };
    if (errors?.length) throw new Error(redactError(errors.map(error => error.message).join("\n")));
    return data;
  }
  // `repository` of a repositoryQuery, or null when GitHub does not show it to the viewer.
  async repository<T>({ host, repository }: Repository, query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
    const [owner, name] = repository.split("/");
    const data = await this.graphql<{ repository?: T | null } | null>(host, query, { owner, name, ...variables });
    return data?.repository ?? null;
  }
  // The branch's open pull request, else its most recently updated one.
  async branchPullRequest(remote: Repository, branch: string): Promise<BranchPullRequest | null> {
    const found = await this.repository<Record<"open" | "latest", { nodes: BranchNode[] }>>(remote, branchQuery, { head: branch });
    if (!found) throw new Error(`GitHub repository ${remote.repository} was not found.`);
    const node = found.open.nodes[0] ?? found.latest.nodes[0];
    return node ? { number: node.number, url: node.url, title: node.title, state: node.state.toLowerCase() as BranchPullRequest["state"] } : null;
  }
}
