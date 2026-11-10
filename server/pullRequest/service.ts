// The pull request panel on the daemon: finds the pull request of the workspace's branch, reads it
// from GitHub behind a short cache shared by every workspace showing it, and runs its writes.
// GitHub's JSON is shaped in shape.ts and checked by each output contract before it leaves an RPC.
import { checksRpc } from "../../shared/pullRequest.ts";
import type { ActionInput, Check, Detail, PrRef, ResolveResult, UpdateInput } from "../../shared/pullRequest.ts";
import { GitHub, UnavailableError } from "../github.ts";
import { redactError, runCommand } from "../process.ts";
import type { Runner } from "../process.ts";
import { ReadCache } from "../readCache.ts";
import * as q from "./queries.ts";
import { toCheck, toDetail } from "./shape.ts";
import { actionMutation, updateMutation } from "./writes.ts";
import type { Mutation } from "./writes.ts";

const ok = { ok: true as const };
const CHECKS_TTL_MS = 10_000;
const DETAIL_TTL_MS = 30_000;

// A pull request on the GitHub host of its workspace's remote.
interface Located { ref: PrRef; github: GitHub; host: string }
type Found<T extends { pullRequest: unknown }> = T & { pullRequest: NonNullable<T["pullRequest"]> };
const cacheGroup = ({ ref, host }: Located) => `${host}/${ref.repository}#${ref.number}`;

export class PullRequestService {
  readonly run: Runner;
  private reads = new ReadCache();
  constructor(run: Runner = runCommand) { this.run = run; }

  async resolve({ directory }: { directory: string }): Promise<ResolveResult> {
    const github = new GitHub(directory, this.run);
    try {
      const remote = await github.remote();
      await github.auth(remote.host);
      const head = (await this.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory })).stdout.trim();
      const branch = head === "HEAD" ? null : head;
      const found = branch ? await github.branchPullRequest(remote, branch) : null;
      if (found) return { status: "found", repository: remote.repository, number: found.number };
      return { status: "none", repository: remote.repository, branch };
    } catch (error) {
      return { status: "unavailable", reason: error instanceof UnavailableError ? error.reason : "error", message: redactError((error as Error).message) };
    }
  }

  checks(ref: PrRef): Promise<{ checks: Check[] }> {
    return this.cached(ref, "checks", CHECKS_TTL_MS, async at => {
      const checks: Check[] = [];
      for await (const nodes of this.rollupPages(at)) checks.push(...nodes.map(toCheck));
      return checksRpc.output.parse({ checks });
    });
  }
  detail(ref: PrRef): Promise<Detail> {
    return this.cached(ref, "detail", DETAIL_TTL_MS, async at => {
      const repo = await this.read<q.DetailRepository>(at, q.detailQuery);
      return toDetail(ref.repository, repo, repo.pullRequest);
    });
  }
  async refresh(ref: PrRef) {
    this.reads.drop(cacheGroup(await this.locate(ref)));
    return ok;
  }

  // Each write plans its mutation from a fresh read, never from the cache.
  async action(input: ActionInput) {
    const at = await this.locate(input);
    await this.write(at, actionMutation(input, await this.read<q.WriteRepository>(at, q.writeStateQuery)));
    return ok;
  }
  async update({ title, body, ...ref }: UpdateInput) {
    const at = await this.locate(ref);
    await this.write(at, updateMutation(await this.read<q.WriteRepository>(at, q.writeStateQuery), { title, body }));
    return ok;
  }

  private async locate(ref: PrRef): Promise<Located> {
    const github = new GitHub(ref.directory, this.run);
    return { ref, github, host: (await github.remote()).host };
  }
  private async read<T extends { pullRequest: unknown }>({ ref, github, host }: Located, query: string, variables: Record<string, unknown> = {}): Promise<Found<T>> {
    const repo = await github.repository<T>({ host, repository: ref.repository }, query, { number: ref.number, ...variables });
    if (!repo?.pullRequest) throw new Error(`Pull request #${ref.number} was not found in ${ref.repository}.`);
    return repo as Found<T>;
  }
  private async cached<T>(ref: PrRef, name: string, ttl: number, load: (at: Located) => Promise<T>): Promise<T> {
    const at = await this.locate(ref);
    return this.reads.read(cacheGroup(at), name, ttl, () => load(at));
  }
  private async write(at: Located, { query, variables }: Mutation) {
    await at.github.graphql(at.host, query, variables);
    this.reads.drop(cacheGroup(at));
  }
  // The head commit's checks, a page at a time; a pull request without commits or checks has none.
  private async *rollupPages(at: Located) {
    let after: string | null = null;
    do {
      const repo: Found<q.ChecksRepository> = await this.read<q.ChecksRepository>(at, q.checksQuery, { after });
      const page = repo.pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
      if (!page) return;
      yield page.nodes;
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
}
