// The Checks section: a summary row with Paseo's checks ring that opens the list, grouped by
// outcome with repeated runs merged into one row.
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { checkPresentation, checksRingSvg, summarizeChecks, type CheckGroupKey, type CheckGroupView, type CheckRow } from "./checks.logic.ts";
import { rpcErrorMessage } from "../rpcErrorMessage.ts";
import { Button, toneColor } from "../ui.tsx";

export interface ChecksSectionProps {
  readonly theme: PluginTheme;
  readonly compact: boolean;
  readonly groups: readonly CheckGroupView[];
  readonly open: boolean;
  readonly onToggle: () => void;
  // Beside the failing group; null where an agent cannot take the fix.
  readonly fixWithAgent: { readonly onPress: () => void; readonly pending: boolean } | null;
}

function CheckRowView({ theme, compact, row }: { readonly theme: PluginTheme; readonly compact: boolean; readonly row: CheckRow }) {
  const { colors } = theme;
  const toast = useToast();
  const presentation = checkPresentation(row.status);
  const secondary = [row.workflowName, row.description].filter((part) => part).join(" · ");
  const url = row.url;
  return (
    <Pressable
      disabled={url === null}
      accessibilityRole={url === null ? undefined : "link"}
      accessibilityLabel={row.name}
      onPress={() => url !== null && void openExternalUrl(url).catch((error: unknown) => toast.error(rpcErrorMessage(error)))}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, height: compact ? 44 : 32, paddingHorizontal: 12, opacity: pressed ? 0.6 : 1 })}
    >
      <Icon name={presentation.icon} size={14} color={toneColor(theme, presentation.tone)} />
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flexShrink: 1, color: colors.foreground, fontSize: 14 }} numberOfLines={1}>
          {row.name}
        </Text>
        {secondary ? (
          <Text style={{ flexShrink: 2, color: colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {secondary}
          </Text>
        ) : null}
      </View>
      {row.required === true ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Required</Text> : null}
      {row.runs > 1 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>×{row.runs}</Text> : null}
      {url !== null ? <Icon name="ExternalLink" size={12} color={colors.foregroundMuted} /> : null}
    </Pressable>
  );
}

export function ChecksSection({ theme, compact, groups, open, onToggle, fixWithAgent }: ChecksSectionProps) {
  const { colors } = theme;
  const [collapsedGroups, setCollapsedGroups] = useState<readonly CheckGroupKey[]>([]);
  const { headline, detail } = summarizeChecks(groups);
  const ring = checksRingSvg(
    groups.map((group) => ({ color: toneColor(theme, group.tone), count: group.rows.length })),
    colors.border,
  );
  const empty = groups.length === 0;
  const toggleGroup = (key: CheckGroupKey) => setCollapsedGroups((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "Hide checks" : "Show checks"}
        accessibilityState={{ expanded: open }}
        disabled={empty}
        onPress={onToggle}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: compact ? 14 : 12, opacity: pressed ? 0.6 : 1 })}
      >
        <Icon icon={{ svg: ring }} size={20} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{headline}</Text>
          {detail ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{detail}</Text> : null}
        </View>
        {empty ? null : <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />}
      </Pressable>
      {open && !empty ? (
        <View style={{ paddingBottom: 8 }}>
          {groups.map((group) => {
            const collapsed = collapsedGroups.includes(group.key);
            return (
              <View key={group.key}>
                <View style={{ flexDirection: "row", alignItems: "center", minHeight: compact ? 40 : 28, paddingTop: 8, paddingBottom: 4, paddingHorizontal: 12 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={group.label}
                    accessibilityState={{ expanded: !collapsed }}
                    hitSlop={6}
                    onPress={() => toggleGroup(group.key)}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, opacity: pressed ? 0.6 : 1 })}
                  >
                    <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "500" }}>{group.label}</Text>
                    <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={12} color={colors.foregroundMuted} />
                  </Pressable>
                  {group.key === "failing" && fixWithAgent ? (
                    <View style={{ marginLeft: "auto" }}>
                      <Button theme={theme} compact={compact} variant="ghost" label="Fix with agent" icon="Bot" pending={fixWithAgent.pending} onPress={fixWithAgent.onPress} />
                    </View>
                  ) : null}
                </View>
                {collapsed ? null : group.rows.map((row, index) => <CheckRowView key={`${row.workflowName ?? ""}/${row.name}/${row.status}/${index}`} theme={theme} compact={compact} row={row} />)}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
