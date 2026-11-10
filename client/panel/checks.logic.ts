// How the Checks section groups, counts and draws a pull request's checks. Pure, so it is unit
// tested apart from the React Native views.
import type { Check, CheckStatus } from "../../shared/pullRequest.ts";
import type { Tone } from "../ui.tsx";

export type CheckGroupKey = "failing" | "pending" | "successful" | "skipped";

const GROUP_ORDER: readonly CheckGroupKey[] = ["failing", "pending", "successful", "skipped"];

const GROUP_TEXT: Record<CheckGroupKey, { readonly one: string; readonly many: string; readonly count: string; readonly tone: Tone }> = {
  failing: { one: "failing check", many: "failing checks", count: "failing", tone: "danger" },
  pending: { one: "check in progress", many: "checks in progress", count: "in progress", tone: "warning" },
  successful: { one: "successful check", many: "successful checks", count: "successful", tone: "success" },
  skipped: { one: "skipped check", many: "skipped checks", count: "skipped", tone: "muted" },
};

// Each status's group and how its row is drawn.
const STATUSES: Record<CheckStatus, { readonly group: CheckGroupKey; readonly icon: string; readonly tone: Tone }> = {
  failure: { group: "failing", icon: "CircleX", tone: "danger" },
  cancelled: { group: "failing", icon: "CircleX", tone: "danger" },
  "action-required": { group: "failing", icon: "CircleAlert", tone: "warning" },
  pending: { group: "pending", icon: "CircleDashed", tone: "warning" },
  success: { group: "successful", icon: "CircleCheck", tone: "success" },
  skipped: { group: "skipped", icon: "CircleMinus", tone: "muted" },
  neutral: { group: "skipped", icon: "CircleMinus", tone: "muted" },
};

export function checkGroup(status: CheckStatus): CheckGroupKey {
  return STATUSES[status].group;
}

export function hasPendingChecks(checks: readonly Pick<Check, "status">[]): boolean {
  return checks.some((check) => check.status === "pending");
}

export function checkPresentation(status: CheckStatus): { readonly icon: string; readonly tone: Tone } {
  const { icon, tone } = STATUSES[status];
  return { icon, tone };
}

// One row per name, workflow and status; `runs` counts the checks it stands for, as when a
// workflow runs on both push and pull_request.
export interface CheckRow extends Check {
  readonly runs: number;
}

export function dedupeChecks(checks: readonly Check[]): CheckRow[] {
  const rows: CheckRow[] = [];
  const byKey = new Map<string, number>();
  for (const check of checks) {
    const key = JSON.stringify([check.name, check.workflowName, check.status]);
    const index = byKey.get(key);
    if (index === undefined) {
      byKey.set(key, rows.length);
      rows.push({ ...check, runs: 1 });
      continue;
    }
    const row = rows[index]!;
    rows[index] = {
      ...row,
      runs: row.runs + 1,
      description: row.description ?? check.description,
      url: row.url ?? check.url,
      required: row.required === true || check.required === true ? true : (row.required ?? check.required),
    };
  }
  return rows;
}

export interface CheckGroupView {
  readonly key: CheckGroupKey;
  readonly label: string;
  readonly tone: Tone;
  readonly rows: readonly CheckRow[];
}

function groupLabel(key: CheckGroupKey, count: number): string {
  return `${count} ${count === 1 ? GROUP_TEXT[key].one : GROUP_TEXT[key].many}`;
}

// Failing first, then in progress, successful and skipped; empty groups are left out.
export function groupChecks(checks: readonly Check[]): CheckGroupView[] {
  const rows = dedupeChecks(checks);
  const groups: CheckGroupView[] = [];
  for (const key of GROUP_ORDER) {
    const inGroup = rows.filter((row) => checkGroup(row.status) === key);
    if (inGroup.length > 0) groups.push({ key, label: groupLabel(key, inGroup.length), tone: GROUP_TEXT[key].tone, rows: inGroup });
  }
  return groups;
}

// The section's headline and count line, counting de-duplicated rows.
export function summarizeChecks(groups: readonly CheckGroupView[]): { readonly headline: string; readonly detail: string | null } {
  const first = groups[0];
  if (!first) return { headline: "No checks", detail: null };
  const headline = first.key === "failing" ? "Some checks were not successful" : first.key === "pending" ? "Some checks haven't completed yet" : "All checks have passed";
  const detail = groups.length === 1 ? first.label : groups.map((group) => `${group.rows.length} ${GROUP_TEXT[group.key].count}`).join(", ");
  return { headline, detail };
}

// Open while something failed or is still running, so the problem is in view; closed when all is well.
export function defaultChecksOpen(groups: readonly CheckGroupView[]): boolean {
  return groups.some((group) => group.key === "failing" || group.key === "pending");
}

const RING_VIEW = 20;
const RING_STROKE = 3;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// The summary ring as a self-contained SVG for <Icon icon={{ svg }} />, ported from Paseo's
// checks-ring.tsx: one arc per part from 12 o'clock, 2 apart, each at least 1.5 long. Colours are
// literal, since the host only substitutes currentColor.
export function checksRingSvg(parts: readonly { readonly color: string; readonly count: number }[], track: string): string {
  const center = RING_VIEW / 2;
  const radius = (RING_VIEW - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const shown = parts.filter((part) => part.count > 0);
  const total = shown.reduce((sum, part) => sum + part.count, 0);
  const circle = (color: string, extra: string) => `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${color}" stroke-width="${RING_STROKE}"${extra}/>`;
  let offset = 0;
  const arcs = shown.map((part) => {
    const arc = (part.count / total) * circumference;
    const dash = shown.length === 1 ? circumference : Math.max(arc - 2, 1.5);
    const svg = circle(part.color, ` stroke-dasharray="${round(dash)} ${round(circumference - dash)}" stroke-dashoffset="${round(-offset)}"`);
    offset += arc;
    return svg;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RING_VIEW}" height="${RING_VIEW}" viewBox="0 0 ${RING_VIEW} ${RING_VIEW}"><g transform="rotate(-90 ${center} ${center})">${circle(track, "")}${arcs.join("")}</g></svg>`;
}
