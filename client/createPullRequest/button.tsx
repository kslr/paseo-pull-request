// The workspace header's Create PR button: one per Git workspace, tracking that checkout's status and
// starting and polling the daemon's run (commit, push, create the pull request); see button.logic.ts
// for when it can. Desktop only.
import type {
  PluginButton,
  PluginButtonBehavior,
  PluginButtonIconProps,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon, useToast, type ToastApi } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { createPullRequestRunRpc, gitStatusRpc, startCreatePullRequestRpc, type GitStatus } from "../../shared/createPullRequest.ts";
import { rpcErrorMessage } from "../rpcErrorMessage.ts";
import {
  CREATE_PULL_REQUEST_LABEL,
  createPullRequestTitle,
  createPullRequestToast,
  resolveCreatePullRequestButton,
  resolveCreatePullRequestProgress,
  type RunningCreatePullRequest,
} from "./button.logic.ts";
import { emit } from "./events.ts";

type Workspace = Awaited<ReturnType<PluginClientContext["paseo"]["workspaces"]["list"]>>["entries"][number];

const BUTTON_ID = "create-pr";
const STATUS_REFRESH_DEBOUNCE_MS = 500;
// Short, so the result shows soon after the daemon finishes; each poll only reads in-memory state.
const RUN_POLL_INTERVAL_MS = 250;
const SUCCESS_TOAST_MS = 10_000;

// Paseo's toast is a hook. The button's icon, which Paseo renders in the header, lends it to the
// code below, which runs outside React (an action's result).
let toast: ToastApi | null = null;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Paseo gives plugin header labels the muted colour at its small size (12px by default) and no option
// to change either; its own git button's label is the foreground colour at the base size (14px). On
// web the label is a DOM text element beside the icon slot: restyle it to match, and again whenever
// Paseo re-renders it. The size scales from Paseo's own, so the interface size setting still applies.
// If Paseo's markup changes, nothing matches and the label keeps Paseo's style.
function brightenHeaderLabel(slot: unknown, color: string): (() => void) | undefined {
  if (Platform.OS !== "web" || !(slot instanceof HTMLElement)) return undefined;
  const button = slot.closest<HTMLElement>('[role="button"],button');
  if (!button) return undefined;
  const apply = () => {
    for (const element of button.querySelectorAll<HTMLElement>("div,span")) {
      if (slot.contains(element) || element.contains(slot)) continue;
      const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      if (!ownText || element.dataset.paseoPrStyled === color) continue;
      element.style.fontSize = "";
      element.style.fontSize = `${(parseFloat(getComputedStyle(element).fontSize) * 14) / 12}px`;
      element.style.color = color;
      element.dataset.paseoPrStyled = color;
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(button, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// The workspace fields Paseo refreshes when the checkout or its pull request changes.
function runtimeKey(workspace: Workspace): string {
  return JSON.stringify([workspace.gitRuntime ?? null, workspace.githubRuntime ?? null]);
}

// Plugin source is evaluated directly by Hermes, without Metro's class transform.
function createPullRequestButton(client: PluginClientContext, workspaceId: string, directory: string, runtime: string) {
  const abort = new AbortController();
  let status: GitStatus | null = null;
  // Only visible buttons fetch status; workspace updates mark hidden ones stale.
  let stale = true;
  let refreshing = false;
  let refreshAgain = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let icons = 0;
  let running: { run: RunningCreatePullRequest | null } | null = null;

  const actionBehavior: PluginButtonBehavior = { kind: "action", onPress: () => press() };

  const ButtonIcon = ({ size, color, theme }: PluginButtonIconProps) => {
    const api = useToast();
    useEffect(() => {
      toast = api;
    }, [api]);
    useEffect(() => iconMounted(), []);
    const slot = useRef<View>(null);
    useEffect(() => brightenHeaderLabel(slot.current, theme.colors.foreground), [theme.colors.foreground]);
    // Paseo draws plugin header labels in the muted colour, beside its own git button's label in the
    // foreground colour; this one is the workspace's primary git action, so its label matches that.
    // The icon keeps Paseo's colour, as the host's git button does.
    return (
      <View ref={slot}>
        <Icon name="GitPullRequest" size={size} color={color} />
      </View>
    );
  };

  function iconMounted(): () => void {
    icons += 1;
    if (stale) refresh();
    return () => {
      icons -= 1;
    };
  }

  function workspaceChanged(nextRuntime: string): void {
    if (nextRuntime === runtime) return;
    runtime = nextRuntime;
    stale = true;
    if (icons === 0) return;
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (stale) refresh();
    }, STATUS_REFRESH_DEBOUNCE_MS);
  }

  function refresh(): void {
    stale = false;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    void (async () => {
      try {
        do {
          refreshAgain = false;
          try {
            status = await client.rpc(gitStatusRpc, { directory });
          } catch (error) {
            // Keep showing the last status; try again when the button is next shown.
            stale = true;
            if (!abort.signal.aborted) console.warn(`Git status failed for ${directory}: ${rpcErrorMessage(error)}`);
          }
          if (abort.signal.aborted) return;
          publish();
        } while (refreshAgain);
      } finally {
        refreshing = false;
      }
    })();
  }

  function publish(): void {
    const state = resolveCreatePullRequestButton(status);
    const patch: Partial<PluginButton> = {};
    if (running !== null) {
      const progress = resolveCreatePullRequestProgress(running.run, Date.now());
      // The pending press shows Paseo's busy state.
      Object.assign(patch, { title: createPullRequestTitle(progress.output), label: progress.label });
    } else {
      // Not disabled when there is nothing to do: Paseo fades a disabled plugin button, which reads
      // as broken beside the host's own. The reason shows on hover and, as a toast, on press.
      Object.assign(patch, { title: createPullRequestTitle(state.kind === "disabled" ? state.hint : null), label: CREATE_PULL_REQUEST_LABEL, disabled: false });
    }
    registration.update(patch);
  }

  async function press(): Promise<void> {
    const state = resolveCreatePullRequestButton(status);
    if (state.kind === "open_pull_request") return openPullRequest();
    if (state.kind === "create") await create();
    if (state.kind === "disabled") toast?.show(state.hint, { variant: "info" });
  }

  function openPullRequest(): void {
    client.openPanel("pull-request", { workspaceId, location: "explorer" });
    emit({ directory });
  }

  // Started and polled. A failure is thrown for Paseo's error toast.
  async function create(): Promise<void> {
    if (running !== null) return;
    const activeRun: { run: RunningCreatePullRequest | null } = { run: null };
    running = activeRun;
    publish();
    const signal = abort.signal;
    const runId = newRunId();
    try {
      let run = await client.rpc(startCreatePullRequestRpc, { directory, runId, workspaceId });
      while (run.status === "running") {
        activeRun.run = run;
        publish();
        await delay(RUN_POLL_INTERVAL_MS, signal);
        run = await client.rpc(createPullRequestRunRpc, { directory, runId });
      }
      if (run.status === "failed") throw new Error(run.message);
      toast?.show(createPullRequestToast(run.result), { variant: "success", durationMs: SUCCESS_TOAST_MS });
      openPullRequest();
    } catch (error) {
      if (signal.aborted) return;
      throw new Error(rpcErrorMessage(error));
    } finally {
      running = null;
      if (!signal.aborted) {
        publish();
        refresh();
      }
    }
  }

  function remove(): void {
    abort.abort();
    if (debounce !== null) clearTimeout(debounce);
    registration.remove();
  }

  const registration = client.addHeaderButton({
    id: BUTTON_ID,
    workspaceId,
    button: { title: CREATE_PULL_REQUEST_LABEL, icon: ButtonIcon, label: CREATE_PULL_REQUEST_LABEL, disabled: true, behavior: actionBehavior },
  });
  publish();
  return { directory, workspaceChanged, remove };
}

export function contributeCreatePullRequestButtons(client: PluginClientContext): () => void {
  if (Platform.OS !== "web") return () => {};
  const lifetime = new AbortController();
  const buttons = new Map<string, ReturnType<typeof createPullRequestButton>>();
  const remove = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };
  const upsert = (workspace: Workspace) => {
    if (lifetime.signal.aborted) return;
    if (workspace.projectKind !== "git" || workspace.archivingAt !== null) return remove(workspace.id);
    const existing = buttons.get(workspace.id);
    if (existing?.directory === workspace.workspaceDirectory) return existing.workspaceChanged(runtimeKey(workspace));
    remove(workspace.id);
    buttons.set(workspace.id, createPullRequestButton(client, workspace.id, workspace.workspaceDirectory, runtimeKey(workspace)));
  };
  const reconcile = (entries: readonly Workspace[]) => {
    const listed = new Set(entries.map((workspace) => workspace.id));
    for (const workspaceId of [...buttons.keys()]) if (!listed.has(workspaceId)) remove(workspaceId);
    for (const workspace of entries) upsert(workspace);
  };
  let stop: (() => void) | null = null;
  // An owned list subscription delivers existing workspaces, then updates, and a fresh snapshot after
  // a reconnect. A snapshot keeps the buttons of workspaces it still lists, so a reconnect neither
  // drops a running action's progress nor refetches every status. The list call takes no abort
  // signal, so the subscription is released by hand, also when cleanup came first.
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ entries, subscription }) => {
      const release = () => void subscription.release().catch(() => undefined);
      if (lifetime.signal.aborted) return release();
      reconcile(entries);
      const unsubscribe = subscription.subscribe({
        snapshot: (snapshot) => reconcile(snapshot.entries),
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsert(update.workspace);
          else remove(update.id);
        },
      });
      stop = () => {
        unsubscribe();
        release();
      };
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("Workspace observation failed", error);
    });
  return () => {
    lifetime.abort();
    stop?.();
    for (const button of buttons.values()) button.remove();
    buttons.clear();
  };
}
