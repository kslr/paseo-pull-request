import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeCreatePullRequestButtons } from "./client/createPullRequest/button.tsx";
import { WorkspacePullRequestPanel } from "./client/panel/WorkspacePullRequestPanel.tsx";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({ id: "pull-request", title: "Pull Request", icon: "GitPullRequest", locations: ["explorer"], Component: WorkspacePullRequestPanel });
  const removeCommand = client.addCommandCenterItem({
    id: "open-pull-request",
    title: "Open pull request",
    icon: "GitPullRequest",
    keywords: ["pr", "github", "review"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("pull-request", { location: "explorer" });
    },
  });
  const removeCreatePullRequestButtons = contributeCreatePullRequestButtons(client);
  return () => {
    removeCreatePullRequestButtons();
    removeCommand();
    removePanel();
  };
}
