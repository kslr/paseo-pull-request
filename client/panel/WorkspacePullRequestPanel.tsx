// The Explorer panel: the pull request of the workspace's branch. Resolved on
// mount, on window focus, after Create PR opens or creates one, and on Refresh.
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, Loading } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, type ReactNode } from "react";
import { Text, View } from "react-native";
import * as c from "../../shared/pullRequest.ts";
import { onPullRequestChanged } from "../pullRequestChanged.ts";
import { PullRequestDetail, pullRequestQueryKey } from "./PullRequestDetail.tsx";
import { describeUnavailable, pickTemplateAgent } from "./pullRequest.logic.ts";
import { rpcErrorMessage } from "../rpcErrorMessage.ts";
import { Button, IconButton, monoFont, Notice, Toolbar } from "../ui.tsx";

type Navigation = PluginWorkspacePanelProps["navigation"];

// A new agent in this workspace, set up like the workspace's most recently active agent, takes the
// prompt, and its tab opens when the host can open agents.
function useAgentHandOff(workspaceId: string, navigation: Navigation) {
  const paseo = usePaseo();
  return useCallback(
    async ({ title, prompt }: { readonly title: string; readonly prompt: string }) => {
      const { entries } = await paseo.agents.list({ sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 100 } });
      const template = pickTemplateAgent(
        entries.map((entry) => entry.agent),
        workspaceId,
      );
      if (!template) throw new Error("Start an agent in this workspace first; the new agent uses its provider and model.");
      const agent = await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider: template.model ? `${template.provider}/${template.model}` : template.provider,
          ...(template.currentModeId ? { modeId: template.currentModeId } : {}),
          ...(template.thinkingOptionId ? { thinkingOptionId: template.thinkingOptionId } : {}),
        },
        title,
        prompt,
      });
      navigation?.openAgent({ agentId: agent.id });
    },
    [paseo, workspaceId, navigation],
  );
}

function BranchPullRequest({ theme, compact, tab, directory, workspaceId, navigation }: { readonly theme: PluginTheme; readonly compact: boolean; readonly tab: PluginWorkspacePanelProps["tab"]; readonly directory: string; readonly workspaceId: string; readonly navigation: Navigation }) {
  const resolve = useRpc(c.resolveRpc);
  const queryClient = useQueryClient();
  const handOff = useAgentHandOff(workspaceId, navigation);
  const resolveKey = pullRequestQueryKey(directory, "resolve");
  const query = useQuery({ queryKey: resolveKey, queryFn: () => resolve({ directory }), staleTime: 0, refetchOnMount: "always" });
  useEffect(
    () =>
      onPullRequestChanged((changed) => {
        if (changed === directory) void queryClient.invalidateQueries({ queryKey: pullRequestQueryKey(directory) });
      }),
    [directory, queryClient],
  );
  const retry = <Button theme={theme} compact={compact} variant="ghost" label="Retry" icon="RotateCw" pending={query.isFetching} onPress={() => void query.refetch()} />;

  const result = query.data;
  if (result === undefined) {
    if (query.error) return <Notice theme={theme} icon="CircleAlert" title="Could not look up the pull request" message={rpcErrorMessage(query.error)}>{retry}</Notice>;
    return <Loading />;
  }
  if (result.status === "unavailable") {
    const { title, message } = describeUnavailable(result);
    return <Notice theme={theme} icon="CircleAlert" title={title} message={message}>{retry}</Notice>;
  }
  if (result.status === "none") {
    return (
      <>
        <Toolbar theme={theme} compact={compact} trailing={<IconButton theme={theme} compact={compact} icon="RotateCw" label="Check again" pending={query.isFetching} onPress={() => void query.refetch()} />}>
          <Icon name="GitBranch" size={14} color={theme.colors.foregroundMuted} />
          <Text style={{ flexShrink: 1, color: result.branch ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12, fontFamily: result.branch ? monoFont() : undefined }} numberOfLines={1}>
            {result.branch ?? "Detached HEAD"}
          </Text>
          {result.repository ? (
            <Text style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
              {result.repository}
            </Text>
          ) : null}
        </Toolbar>
        <Notice
          theme={theme}
          icon="GitPullRequest"
          title={result.branch ? `No pull request for ${result.branch}` : "No branch checked out"}
          message={result.branch ? "Use Create PR in the workspace header to open one." : "HEAD is detached. Check out a branch to see its pull request."}
        />
      </>
    );
  }
  return <PullRequestDetail key={`${result.repository}#${result.number}`} theme={theme} compact={compact} tab={tab} prRef={{ directory, repository: result.repository, number: result.number }} handOff={handOff} />;
}

export function WorkspacePullRequestPanel({ theme, layout, tab, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const projectKind = useWorkspace(workspaceId, (workspace) => workspace.projectKind);
  let content: ReactNode;
  if (directory === null) content = <Loading />;
  else if (projectKind !== "git") content = <Notice theme={theme} icon="CircleAlert" title="Not a Git workspace" message="Pull requests are shown for workspaces inside a Git repository with a GitHub remote." />;
  else content = <BranchPullRequest theme={theme} compact={layout.compact} tab={tab} directory={directory} workspaceId={workspaceId} navigation={navigation} />;
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>{content}</View>;
}
