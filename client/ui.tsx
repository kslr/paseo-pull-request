// The panel's small building blocks on React Native and Paseo's plugin UI, coloured from the host
// theme so they follow the user's Paseo theme on every platform. Sizes follow Paseo's own controls:
// 28px pill buttons, 36px toolbar rows, 26px icon buttons, and touch sizes when compact.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";

// What a status means, coloured from the theme; "default" is the foreground colour.
export type Tone = "success" | "warning" | "danger" | "accent" | "muted" | "default";
const TONE_COLORS: Record<Tone, keyof PluginTheme["colors"]> = {
  success: "statusSuccess",
  warning: "statusWarning",
  danger: "statusDanger",
  accent: "accent",
  muted: "foregroundMuted",
  default: "foreground",
};

export function toneColor(theme: PluginTheme, tone: Tone): string {
  return theme.colors[TONE_COLORS[tone]];
}

export function monoFont(): string {
  return Platform.OS === "ios" ? "Menlo" : "monospace";
}

export interface ButtonProps {
  readonly theme: PluginTheme;
  readonly label: string;
  readonly onPress: () => void;
  readonly icon?: string;
  readonly variant?: "primary" | "outline" | "danger" | "ghost";
  // md is as tall as a text input.
  readonly size?: "sm" | "md";
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly pending?: boolean;
}

function buttonColors(theme: PluginTheme, variant: NonNullable<ButtonProps["variant"]>) {
  const { colors } = theme;
  if (variant === "primary") return { background: colors.accent, foreground: colors.accentForeground, border: "transparent" };
  if (variant === "danger") return { background: "transparent", foreground: colors.statusDanger, border: colors.border };
  if (variant === "outline") return { background: "transparent", foreground: colors.foreground, border: colors.border };
  return { background: "transparent", foreground: colors.foreground, border: "transparent" };
}

function buttonHeight(variant: NonNullable<ButtonProps["variant"]>, size: "sm" | "md", compact: boolean): number {
  if (size === "md") return compact ? 36 : 32;
  if (variant === "ghost") return compact ? 32 : 24;
  return compact ? 32 : 28;
}

function ButtonContent({ label, icon, foreground, pending, fontSize }: { readonly label: string; readonly icon?: string; readonly foreground: string; readonly pending: boolean; readonly fontSize: number }) {
  return (
    <>
      {pending ? <ActivityIndicator size="small" color={foreground} /> : icon ? <Icon name={icon} size={14} color={foreground} /> : null}
      <Text style={{ color: foreground, fontSize, fontWeight: "500" }} numberOfLines={1}>
        {label}
      </Text>
    </>
  );
}

// Paseo's pill button.
export function Button({ theme, label, onPress, icon, variant = "outline", size = "sm", compact = false, disabled = false, pending = false }: ButtonProps) {
  const { background, foreground, border } = buttonColors(theme, variant);
  const inactive = disabled || pending;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: pending }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: buttonHeight(variant, size, compact),
        paddingHorizontal: size === "md" ? 16 : variant === "ghost" ? 8 : 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: background,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <ButtonContent label={label} icon={icon} foreground={foreground} pending={pending} fontSize={size === "md" ? 14 : 12} />
    </Pressable>
  );
}

// A primary pill split in two: the action on the left, a chevron that opens its options on the
// right. The 1px gap shows the background behind as the divider.
export function SplitButton({
  theme,
  label,
  icon,
  menuLabel,
  onPress,
  onMenu,
  compact = false,
  pending = false,
  disabled = false,
}: {
  readonly theme: PluginTheme;
  readonly label: string;
  readonly icon: string;
  readonly menuLabel: string;
  readonly onPress: () => void;
  readonly onMenu: () => void;
  readonly compact?: boolean;
  readonly pending?: boolean;
  readonly disabled?: boolean;
}) {
  const { colors } = theme;
  const inactive = disabled || pending;
  const height = compact ? 32 : 28;
  const half = (pressed: boolean) => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: 6, height, backgroundColor: colors.accent, opacity: pressed ? 0.8 : 1 });
  return (
    <View style={{ flexDirection: "row", gap: 1, opacity: disabled ? 0.5 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: inactive, busy: pending }}
        disabled={inactive}
        onPress={onPress}
        style={({ pressed }) => ({ ...half(pressed), paddingLeft: 12, paddingRight: 10, borderTopLeftRadius: 999, borderBottomLeftRadius: 999, borderTopRightRadius: 4, borderBottomRightRadius: 4 })}
      >
        <ButtonContent label={label} icon={icon} foreground={colors.accentForeground} pending={pending} fontSize={12} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={menuLabel}
        disabled={inactive}
        onPress={onMenu}
        style={({ pressed }) => ({ ...half(pressed), paddingLeft: compact ? 8 : 6, paddingRight: compact ? 10 : 8, borderTopLeftRadius: 4, borderBottomLeftRadius: 4, borderTopRightRadius: 999, borderBottomRightRadius: 999 })}
      >
        <Icon name="ChevronDown" size={14} color={colors.accentForeground} />
      </Pressable>
    </View>
  );
}

// A toolbar glyph. `pending` swaps the icon for a still Loader and disables it: the SDK's Loading
// fills a panel and has no inline size.
export function IconButton({
  theme,
  icon,
  label,
  onPress,
  compact = false,
  small = false,
  pending = false,
}: {
  readonly theme: PluginTheme;
  readonly icon: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly compact?: boolean;
  readonly small?: boolean;
  readonly pending?: boolean;
}) {
  const box = small ? (compact ? 36 : 22) : compact ? 44 : 26;
  const glyph = small ? 14 : compact ? 20 : 16;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: pending, busy: pending }}
      disabled={pending}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ width: box, height: box, alignItems: "center", justifyContent: "center", borderRadius: 6, opacity: pressed ? 0.6 : 1 })}
    >
      <Icon name={pending ? "Loader" : icon} size={glyph} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

export function Toolbar({ theme, compact, children, trailing }: { readonly theme: PluginTheme; readonly compact: boolean; readonly children: ReactNode; readonly trailing: ReactNode }) {
  const { colors } = theme;
  return (
    <View
      style={{
        height: compact ? 44 : 36,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingLeft: 12,
        paddingRight: compact ? 4 : 8,
        backgroundColor: colors.surface0,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>{children}</View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 0 : 2 }}>{trailing}</View>
    </View>
  );
}

export function Divider({ theme }: { readonly theme: PluginTheme }) {
  return <View style={{ height: 1, backgroundColor: theme.colors.border }} />;
}

// A centred message filling the panel: no pull request, or why there cannot be one.
export function Notice({ theme, icon, title, message, children }: { readonly theme: PluginTheme; readonly icon: string; readonly title: string; readonly message: string; readonly children?: ReactNode }) {
  const { colors } = theme;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 }}>
      <Icon name={icon} size={20} color={colors.foregroundMuted} />
      <Text style={{ marginTop: 4, color: colors.foreground, fontSize: 14, fontWeight: "500", textAlign: "center" }}>{title}</Text>
      <Text selectable style={{ maxWidth: 340, color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, textAlign: "center" }}>
        {message}
      </Text>
      {children}
    </View>
  );
}

// A row of a menu in a Modal.
export function MenuRow({
  theme,
  icon,
  label,
  danger = false,
  selected = false,
  disabled = false,
  onPress,
}: {
  readonly theme: PluginTheme;
  readonly icon?: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const { colors } = theme;
  const color = danger ? colors.statusDanger : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 40,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: pressed ? colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={16} color={danger ? colors.statusDanger : colors.foregroundMuted} /> : null}
      <Text style={{ flex: 1, color, fontSize: 14 }}>{label}</Text>
      {selected ? <Icon name="Check" size={16} color={colors.foreground} /> : null}
    </Pressable>
  );
}

export function MenuSeparator({ theme }: { readonly theme: PluginTheme }) {
  return <View style={{ height: 1, marginVertical: 8, marginHorizontal: 8, backgroundColor: theme.colors.border }} />;
}

export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
}

// One modal for every confirmation; `request` null keeps it closed.
export function ConfirmModal({ theme, request, onClose }: { readonly theme: PluginTheme; readonly request: ConfirmRequest | null; readonly onClose: () => void }) {
  return (
    <Modal title={request?.title ?? ""} open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{request?.message}</Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Button theme={theme} size="md" label="Cancel" onPress={onClose} />
          <Button
            theme={theme}
            size="md"
            variant={request?.danger ? "danger" : "primary"}
            label={request?.confirmLabel ?? ""}
            onPress={() => {
              request?.onConfirm();
              onClose();
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export interface TextEditModalProps {
  readonly theme: PluginTheme;
  readonly title: string;
  readonly open: boolean;
  readonly initialValue: string;
  readonly multiline?: boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSave: (value: string) => void;
}

export function TextEditModal({ theme, title, open, initialValue, multiline = false, pending, onClose, onSave }: TextEditModalProps) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);
  const { colors } = theme;
  const empty = !multiline && value.trim() === "";
  return (
    <Modal title={title} open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content>
        <TextInput
          value={value}
          onChangeText={setValue}
          multiline={multiline}
          autoFocus
          editable={!pending}
          textAlignVertical={multiline ? "top" : "center"}
          style={{
            minHeight: multiline ? 220 : 32,
            paddingHorizontal: 12,
            paddingVertical: multiline ? 8 : 0,
            borderWidth: 1,
            borderRadius: 8,
            borderColor: colors.border,
            backgroundColor: colors.surface0,
            color: colors.foreground,
            fontSize: 14,
          }}
        />
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Button theme={theme} size="md" label="Cancel" onPress={onClose} disabled={pending} />
          <Button theme={theme} size="md" variant="primary" label="Save" pending={pending} disabled={empty || value === initialValue} onPress={() => onSave(multiline ? value : value.trim())} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
