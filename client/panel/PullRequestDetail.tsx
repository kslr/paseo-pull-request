// A pull request's detail in the panel: a toolbar row, then the title and meta line, the merge card,
// checks and description, laid out top to bottom in one scroll view. The less frequent actions live
// in the toolbar's "…" menu.
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc, type PluginTab } from "@getpaseo/plugin/client";
import { copyText, Icon, Loading, Markdown, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import * as c from "../../shared/pullRequest.ts";
import { defaultChecksOpen, groupChecks, hasPendingChecks } from "./checks.logic.ts";
import { ChecksSection } from "./checks.tsx";
import { demoteHeadings } from "./markdown.logic.ts";
import {
  autoMergeNote,
  buildFixFailingChecksPrompt,
  buildResolveConflictsPrompt,
  describeState,
  describeTimestamp,
  formatCount,
  MERGE_METHOD_LABELS,
  mergeNote,
  resolveMergeCard,
  resolveMergeMethod,
  resolveMoreActions,
  type MergeCard,
  type MoreAction,
} from "./pullRequest.logic.ts";
import { rpcErrorMessage } from "../rpcErrorMessage.ts";
import { Button, ConfirmModal, Divider, IconButton, MenuRow, MenuSeparator, monoFont, Notice, SplitButton, TextEditModal, toneColor, Toolbar, type ConfirmRequest } from "../ui.tsx";

const CHECKS_POLL_MS = 10_000;
// A second modal opens once the first has closed, so the two never animate over each other.
const MODAL_HANDOFF_MS = 250;

// Every query of one workspace's panel starts with this, so one invalidation reaches them all.
export function pullRequestQueryKey(directory: string, ...rest: readonly (string | number)[]) {
  return ["paseo-pull-request", directory, ...rest];
}

// What the panel keeps in its tab state.
interface TabState {
  readonly mergeMethod?: c.MergeMethod;
  // Set once the user opens or closes Checks; until then it follows the checks' outcome.
  readonly checksOpen?: boolean;
}

function readTabState(state: unknown): TabState {
  return typeof state === "object" && state !== null && !Array.isArray(state) ? (state as TabState) : {};
}

export interface PullRequestDetailProps {
  readonly theme: PluginTheme;
  readonly compact: boolean;
  readonly tab: PluginTab;
  readonly prRef: c.PrRef;
  // Starts an agent in the workspace on the prompt.
  readonly handOff: (task: { readonly title: string; readonly prompt: string }) => Promise<void>;
}

const MORE_ACTIONS: Record<MoreAction, { readonly label: string; readonly icon: string; readonly success: string }> = {
  draft: { label: "Convert to draft", icon: "FilePen", success: "Converted to draft" },
  close: { label: "Close pull request", icon: "CircleX", success: "Pull request closed" },
  reopen: { label: "Reopen", icon: "RotateCcw", success: "Pull request reopened" },
  "delete-branch": { label: "Delete branch", icon: "Trash2", success: "Branch deleted" },
};

// The width a dot takes between two parts of the meta line.
const META_DOT = 15;

function MetaText({ theme, color, mono = false, children }: { readonly theme: PluginTheme; readonly color?: string; readonly mono?: boolean; readonly children: ReactNode }) {
  return <Text style={{ color: color ?? theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, ...(mono ? { fontFamily: monoFont() } : {}) }}>{children}</Text>;
}

function MetaLine({ theme, detail }: { readonly theme: PluginTheme; readonly detail: c.Detail }) {
  const { colors } = theme;
  const when = describeTimestamp(detail, Date.now());
  const parts: { readonly key: string; readonly content: ReactNode; readonly shrink?: boolean }[] = [
    {
      key: "branch",
      shrink: true,
      content: (
        <>
          <Icon name="GitBranch" size={12} color={colors.foregroundMuted} />
          <Text style={{ flexShrink: 1, fontSize: 12, lineHeight: 16 }} numberOfLines={1}>
            <MetaText theme={theme} color={colors.foreground} mono>
              {detail.headBranch}
            </MetaText>
            <MetaText theme={theme}> → </MetaText>
            <MetaText theme={theme} color={colors.foreground} mono>
              {detail.baseBranch}
            </MetaText>
          </Text>
        </>
      ),
    },
  ];
  if (detail.author) parts.push({ key: "author", content: <MetaText theme={theme}>{detail.author.login}</MetaText> });
  if (when) parts.push({ key: "when", content: <MetaText theme={theme}>{when}</MetaText> });
  parts.push({
    key: "stats",
    content: (
      <>
        <MetaText theme={theme} color={colors.statusSuccess}>
          +{formatCount(detail.additions)}
        </MetaText>
        <MetaText theme={theme} color={colors.statusDanger}>
          −{formatCount(detail.deletions)}
        </MetaText>
        <MetaText theme={theme}>
          {formatCount(detail.changedFiles)} {detail.changedFiles === 1 ? "file" : "files"}
        </MetaText>
      </>
    ),
  });
  // Every part leads with its dot, and the row is shifted left by one dot and clipped: the dot of a
  // part that starts a line falls outside, so no line starts or ends with one.
  return (
    <View style={{ overflow: "hidden" }}>
      <View style={{ marginLeft: -META_DOT, flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 4 }}>
        {parts.map((part) => (
          <View key={part.key} style={{ flexDirection: "row", alignItems: "center", ...(part.shrink ? { minWidth: 0, flexShrink: 1 } : {}) }}>
            <Text style={{ width: META_DOT, textAlign: "center", color: colors.foregroundMuted, fontSize: 12, lineHeight: 16 }}>·</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: part.key === "stats" ? 6 : 4, ...(part.shrink ? { minWidth: 0, flexShrink: 1 } : {}) }}>{part.content}</View>
          </View>
        ))}
      </View>
    </View>
  );
}

function MergeCardView({ theme, card: { icon, tone, title, reason }, children }: { readonly theme: PluginTheme; readonly card: MergeCard; readonly children?: ReactNode }) {
  const { colors } = theme;
  return (
    <View style={{ marginHorizontal: 12, marginBottom: 16, padding: 12, gap: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ paddingTop: 2 }}>
          <Icon name={icon} size={16} color={toneColor(theme, tone)} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500", lineHeight: 20 }}>{title}</Text>
          <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
            {reason}
          </Text>
        </View>
      </View>
      {children ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 8, paddingLeft: 26 }}>{children}</View> : null}
    </View>
  );
}

function ActionNote({ theme, children }: { readonly theme: PluginTheme; readonly children: string }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{children}</Text>;
}

export function PullRequestDetail({ theme, compact, tab, prRef: ref, handOff }: PullRequestDetailProps) {
  const { colors } = theme;
  const toast = useToast();
  const queryClient = useQueryClient();
  const detailRpc = useRpc(c.detailRpc);
  const checksRpc = useRpc(c.checksRpc);
  const actionRpc = useRpc(c.actionRpc);
  const updateRpc = useRpc(c.updateRpc);
  const refreshRpc = useRpc(c.refreshRpc);
  const detailQuery = useQuery({ queryKey: pullRequestQueryKey(ref.directory, "detail", ref.repository, ref.number), queryFn: () => detailRpc(ref) });
  const checksQuery = useQuery({
    queryKey: pullRequestQueryKey(ref.directory, "checks", ref.repository, ref.number),
    queryFn: () => checksRpc(ref),
    refetchInterval: (query) => (hasPendingChecks(query.state.data?.checks ?? []) ? CHECKS_POLL_MS : false),
  });
  const [pending, setPending] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [editing, setEditing] = useState<"title" | "body" | null>(null);
  const [modal, setModal] = useState<"more" | "merge-method" | null>(null);
  const [descriptionOpen, setDescriptionOpen] = useState(true);
  // tab.state is read once; later writes are mirrored here.
  const [tabState, setTabState] = useState<TabState>(() => readTabState(tab.state));
  const modalHandOff = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (modalHandOff.current && clearTimeout(modalHandOff.current)), []);

  const detail = detailQuery.data;
  const checks = checksQuery.data?.checks ?? [];
  const checksPending = hasPendingChecks(checks);
  // Finished checks can unblock merging; read the merge state again when they settle.
  const wasPending = useRef(checksPending);
  useEffect(() => {
    if (wasPending.current && !checksPending) void detailQuery.refetch();
    wasPending.current = checksPending;
  }, [checksPending]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: pullRequestQueryKey(ref.directory) });
  const saveTabState = (patch: TabState) => {
    const next = { ...tabState, ...patch };
    setTabState(next);
    tab.setState(next);
  };
  // Closes the open modal, then runs `next` once it is gone.
  const closeModalThen = (next: () => void) => {
    setModal(null);
    if (modalHandOff.current) clearTimeout(modalHandOff.current);
    modalHandOff.current = setTimeout(next, MODAL_HANDOFF_MS);
  };

  // One write at a time: its button shows progress and the others wait.
  const write = async (key: string, run: () => Promise<unknown>, success: string | null): Promise<boolean> => {
    if (pending !== null) return false;
    setPending(key);
    try {
      await run();
      if (success) toast.show(success, { variant: "success" });
      await invalidate();
      return true;
    } catch (error) {
      toast.error(rpcErrorMessage(error));
      return false;
    } finally {
      setPending(null);
    }
  };
  const action = (request: c.ActionRequest, success: string) => write(request.action, () => actionRpc({ ...ref, ...request }), success);
  const openUrl = (url: string) => void openExternalUrl(url).catch((error: unknown) => toast.error(rpcErrorMessage(error)));

  // Shown once both have loaded, so the merge card never explains itself without the checks.
  if (detail === undefined || checksQuery.data === undefined) {
    const error = detailQuery.error ?? checksQuery.error;
    if (!error) return <Loading />;
    const retry = () => void Promise.all([detailQuery.refetch(), checksQuery.refetch()]);
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
        <Notice theme={theme} icon="CircleAlert" title={`Could not load pull request #${ref.number}`} message={rpcErrorMessage(error)}>
          <Button theme={theme} compact={compact} variant="ghost" label="Retry" icon="RotateCw" pending={detailQuery.isFetching || checksQuery.isFetching} onPress={retry} />
        </Notice>
      </View>
    );
  }

  const state = describeState(detail);
  const card = resolveMergeCard(detail, checks);
  const mergeMethods = card?.action?.kind === "merge" || card?.action?.kind === "enable-auto-merge" ? card.action.methods : [];
  const mergeMethod = resolveMergeMethod(detail.mergeCapabilities, tabState.mergeMethod);
  const moreActions = resolveMoreActions(detail);
  const editable = detail.permissions.editChangeRequest;
  const groups = groupChecks(checks);
  const checksOpen = tabState.checksOpen ?? defaultChecksOpen(groups);
  const failing = groups.find((group) => group.key === "failing")?.rows ?? [];
  const canFixChecks = detail.state === "open" && failing.length > 0;

  const confirmMore = (name: MoreAction) => {
    const { label, success } = MORE_ACTIONS[name];
    if (name === "close") {
      setConfirm({ title: "Close pull request?", message: `#${detail.number} will be closed without merging. You can reopen it later.`, confirmLabel: "Close", danger: true, onConfirm: () => void action({ action: name }, success) });
    } else if (name === "delete-branch") {
      setConfirm({ title: "Delete branch?", message: `The branch ${detail.headBranch} will be deleted on GitHub.`, confirmLabel: label, danger: true, onConfirm: () => void action({ action: name }, success) });
    } else void action({ action: name }, success);
  };

  const mergeActions = ({ action: cardAction }: MergeCard): ReactNode => {
    switch (cardAction?.kind) {
      case "fix-conflicts":
        return (
          <>
            <Button
              theme={theme}
              compact={compact}
              variant="primary"
              label="Fix with agent"
              icon="Bot"
              pending={pending === "resolve-conflicts"}
              onPress={() =>
                void write("resolve-conflicts", () => handOff({ title: `Resolve conflicts in PR #${detail.number}`, prompt: buildResolveConflictsPrompt(detail) }), "Started an agent to resolve the conflicts")
              }
            />
            <ActionNote theme={theme}>Merging is unavailable until the conflicts are resolved</ActionNote>
          </>
        );
      case "ready":
        return <Button theme={theme} compact={compact} variant="primary" label="Ready for review" icon="Eye" pending={pending === "ready"} onPress={() => void action({ action: "ready" }, "Marked ready for review")} />;
      case "disable-auto-merge":
        return <Button theme={theme} compact={compact} variant="ghost" label="Disable" pending={pending === "disable-auto-merge"} onPress={() => void action({ action: "disable-auto-merge" }, "Auto-merge disabled")} />;
      case "merge":
      case "enable-auto-merge": {
        if (!mergeMethod) return null;
        const kind = cardAction.kind, merge = kind === "merge";
        return (
          <>
            <SplitButton
              theme={theme}
              compact={compact}
              label={merge ? "Merge" : "Enable auto-merge"}
              icon={merge ? "GitMerge" : "Clock"}
              pending={pending === kind}
              disabled={pending !== null && pending !== kind}
              menuLabel="Merge method"
              onMenu={() => setModal("merge-method")}
              onPress={() =>
                merge
                  ? setConfirm({
                      title: "Merge pull request?",
                      message: `${MERGE_METHOD_LABELS[mergeMethod]}: #${detail.number} into ${detail.baseBranch}.`,
                      confirmLabel: "Merge",
                      onConfirm: () => void action({ action: "merge", mergeMethod }, "Merge submitted"),
                    })
                  : void action({ action: "enable-auto-merge", mergeMethod }, "Auto-merge enabled")
              }
            />
            <ActionNote theme={theme}>{merge ? mergeNote(mergeMethod, detail.baseBranch) : autoMergeNote(mergeMethod)}</ActionNote>
          </>
        );
      }
      default:
        return null;
    }
  };

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
      <Toolbar
        theme={theme}
        compact={compact}
        trailing={
          <>
            <IconButton theme={theme} compact={compact} icon="RotateCw" label="Refresh" pending={pending === "refresh"} onPress={() => void write("refresh", () => refreshRpc(ref), null)} />
            <IconButton theme={theme} compact={compact} icon="ExternalLink" label="Open on GitHub" onPress={() => openUrl(detail.url)} />
            <IconButton theme={theme} compact={compact} icon="Ellipsis" label="More actions" onPress={() => setModal("more")} />
          </>
        }
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name={state.icon} size={14} color={toneColor(theme, state.tone)} />
          <Text style={{ color: toneColor(theme, state.labelTone), fontSize: 12, fontWeight: "500" }}>{state.label}</Text>
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>#{detail.number}</Text>
        <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
          {detail.repository}
        </Text>
      </Toolbar>

      <ScrollView style={{ flex: 1 }}>
        <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 14, gap: 8 }}>
          <Text selectable style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", lineHeight: 22 }}>
            {detail.title}
          </Text>
          <MetaLine theme={theme} detail={detail} />
        </View>

        {card ? (
          <MergeCardView theme={theme} card={card}>
            {mergeActions(card)}
          </MergeCardView>
        ) : null}

        <Divider theme={theme} />
        <ChecksSection
          theme={theme}
          compact={compact}
          groups={groups}
          open={checksOpen}
          onToggle={() => saveTabState({ checksOpen: !checksOpen })}
          fixWithAgent={
            canFixChecks
              ? {
                  pending: pending === "fix-checks",
                  onPress: () =>
                    void write("fix-checks", () => handOff({ title: `Fix failing checks in PR #${detail.number}`, prompt: buildFixFailingChecksPrompt(detail, failing) }), "Started an agent to fix the failing checks"),
                }
              : null
          }
        />
        <Divider theme={theme} />

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 36, paddingVertical: 6, paddingLeft: 12, paddingRight: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={descriptionOpen ? "Hide description" : "Show description"}
            accessibilityState={{ expanded: descriptionOpen }}
            onPress={() => setDescriptionOpen(!descriptionOpen)}
            style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch", opacity: pressed ? 0.6 : 1 })}
          >
            <Icon name={descriptionOpen ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "500" }}>Description</Text>
          </Pressable>
          {editable ? <IconButton theme={theme} compact={compact} small icon="Pencil" label="Edit description" onPress={() => setEditing("body")} /> : null}
        </View>
        {descriptionOpen ? (
          <View style={{ paddingTop: 4, paddingHorizontal: 16, paddingBottom: 20 }}>
            {detail.body.trim() ? <Markdown>{demoteHeadings(detail.body)}</Markdown> : <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No description provided.</Text>}
          </View>
        ) : null}
      </ScrollView>

      <Modal title={`Pull request #${detail.number}`} open={modal === "more"} onOpenChange={(open) => !open && setModal(null)}>
        <Modal.Content contentContainerStyle={{ padding: 8, gap: 0 }}>
          <MenuRow
            theme={theme}
            icon="Link"
            label="Copy link"
            onPress={() => {
              setModal(null);
              void copyText(detail.url).then(
                () => toast.show("Link copied", { variant: "success" }),
                (error: unknown) => toast.error(rpcErrorMessage(error)),
              );
            }}
          />
          {editable ? <MenuRow theme={theme} icon="Pencil" label="Edit title" onPress={() => closeModalThen(() => setEditing("title"))} /> : null}
          {moreActions.length > 0 ? <MenuSeparator theme={theme} /> : null}
          {moreActions.map((name) => {
            const danger = name === "close" || name === "delete-branch";
            return (
              <MenuRow
                key={name}
                theme={theme}
                icon={MORE_ACTIONS[name].icon}
                label={MORE_ACTIONS[name].label}
                danger={danger}
                disabled={pending !== null}
                onPress={() => (danger ? closeModalThen(() => confirmMore(name)) : (setModal(null), confirmMore(name)))}
              />
            );
          })}
        </Modal.Content>
      </Modal>

      <Modal title="Merge method" open={modal === "merge-method"} onOpenChange={(open) => !open && setModal(null)}>
        <Modal.Content contentContainerStyle={{ padding: 8, gap: 0 }}>
          {mergeMethods.map((method) => (
            <MenuRow
              key={method}
              theme={theme}
              label={MERGE_METHOD_LABELS[method]}
              selected={method === mergeMethod}
              onPress={() => {
                saveTabState({ mergeMethod: method });
                setModal(null);
              }}
            />
          ))}
        </Modal.Content>
      </Modal>

      <ConfirmModal theme={theme} request={confirm} onClose={() => setConfirm(null)} />
      <TextEditModal
        theme={theme}
        title="Edit title"
        open={editing === "title"}
        initialValue={detail.title}
        pending={pending === "title"}
        onClose={() => setEditing(null)}
        onSave={(title) => void write("title", () => updateRpc({ ...ref, title }), "Title updated").then((saved) => saved && setEditing(null))}
      />
      <TextEditModal
        theme={theme}
        title="Edit description"
        open={editing === "body"}
        multiline
        initialValue={detail.body}
        pending={pending === "body"}
        onClose={() => setEditing(null)}
        onSave={(body) => void write("body", () => updateRpc({ ...ref, body }), "Description updated").then((saved) => saved && setEditing(null))}
      />
    </View>
  );
}
