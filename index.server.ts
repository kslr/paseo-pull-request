import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as pr from "./shared/pullRequest.ts";
import * as createPr from "./shared/createPullRequest.ts";
import { PullRequestService } from "./server/pullRequest/service.ts";
import { CreatePullRequestService } from "./server/createPullRequest/service.ts";

export default function contribute(server: PluginServerContext) {
  const pullRequests = new PullRequestService();
  const create = new CreatePullRequestService();
  server.handle(pr.resolveRpc, input => pullRequests.resolve(input));
  server.handle(pr.detailRpc, input => pullRequests.detail(input));
  server.handle(pr.checksRpc, input => pullRequests.checks(input));
  server.handle(pr.actionRpc, input => pullRequests.action(input));
  server.handle(pr.updateRpc, input => pullRequests.update(input));
  server.handle(pr.refreshRpc, input => pullRequests.refresh(input));
  server.handle(createPr.gitStatusRpc, input => create.status(input));
  server.handle(createPr.startCreatePullRequestRpc, (input, { paseo }) => create.start(input, paseo));
  server.handle(createPr.createPullRequestRunRpc, input => create.poll(input));
  return () => create.cleanup();
}
