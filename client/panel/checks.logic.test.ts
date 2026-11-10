import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSvgIconProblem } from "@getpaseo/plugin";
import type { Check } from "../../shared/pullRequest.ts";
import { checkPresentation, checksRingSvg, dedupeChecks, defaultChecksOpen, groupChecks, hasPendingChecks, summarizeChecks } from "./checks.logic.ts";

function check(name: string, status: Check["status"], overrides: Partial<Check> = {}): Check {
  return { name, status, description: null, url: null, required: null, workflowName: "CI", ...overrides };
}

describe("dedupeChecks", () => {
  it("merges runs of one check with the same status", () => {
    const rows = dedupeChecks([
      check("test", "failure", { required: null, url: null, description: "exit 1" }),
      check("build", "pending"),
      check("test", "failure", { required: true, url: "https://x/2" }),
      check("build", "success"),
      check("test", "failure", { workflowName: "Nightly" }),
    ]);
    assert.deepEqual(
      rows.map((row) => [row.name, row.workflowName, row.status, row.runs, row.required, row.url, row.description]),
      [
        ["test", "CI", "failure", 2, true, "https://x/2", "exit 1"],
        ["build", "CI", "pending", 1, null, null, null],
        ["build", "CI", "success", 1, null, null, null],
        ["test", "Nightly", "failure", 1, null, null, null],
      ],
    );
    assert.equal(dedupeChecks([check("a", "success", { required: false }), check("a", "success")])[0]?.required, false);
  });
});

describe("groupChecks", () => {
  it("orders failing, in progress, successful and skipped, and counts rows", () => {
    const groups = groupChecks([
      check("a", "success"),
      check("b", "skipped"),
      check("c", "pending"),
      check("d", "failure"),
      check("d", "failure"),
      check("e", "cancelled"),
      check("f", "action-required"),
      check("g", "neutral"),
      check("h", "success"),
    ]);
    assert.deepEqual(
      groups.map((group) => [group.key, group.label, group.tone, group.rows.map((row) => row.name)]),
      [
        ["failing", "3 failing checks", "danger", ["d", "e", "f"]],
        ["pending", "1 check in progress", "warning", ["c"]],
        ["successful", "2 successful checks", "success", ["a", "h"]],
        ["skipped", "2 skipped checks", "muted", ["b", "g"]],
      ],
    );
    assert.deepEqual(groupChecks([]), []);
  });

  it("summarizes the worst outcome first", () => {
    assert.deepEqual(summarizeChecks(groupChecks([check("a", "failure"), check("b", "pending"), check("c", "success"), check("d", "success"), check("e", "success")])), {
      headline: "Some checks were not successful",
      detail: "1 failing, 1 in progress, 3 successful",
    });
    assert.deepEqual(summarizeChecks(groupChecks([check("a", "pending"), check("b", "pending"), check("c", "success")])), { headline: "Some checks haven't completed yet", detail: "2 in progress, 1 successful" });
    assert.deepEqual(summarizeChecks(groupChecks([check("a", "success"), check("a", "success"), check("b", "success")])), { headline: "All checks have passed", detail: "2 successful checks" });
    assert.deepEqual(summarizeChecks(groupChecks([check("a", "success"), check("b", "skipped")])), { headline: "All checks have passed", detail: "1 successful, 1 skipped" });
    assert.deepEqual(summarizeChecks([]), { headline: "No checks", detail: null });
  });

  it("opens by default while something failed or is running", () => {
    assert.equal(defaultChecksOpen(groupChecks([check("a", "success"), check("b", "failure")])), true);
    assert.equal(defaultChecksOpen(groupChecks([check("a", "pending")])), true);
    assert.equal(defaultChecksOpen(groupChecks([check("a", "success"), check("b", "skipped")])), false);
    assert.equal(defaultChecksOpen([]), false);
  });

  it("presents each status", () => {
    assert.equal(hasPendingChecks([{ status: "success" }, { status: "pending" }]), true);
    assert.equal(hasPendingChecks([{ status: "success" }]), false);
    assert.deepEqual(checkPresentation("failure"), { icon: "CircleX", tone: "danger" });
    assert.deepEqual(checkPresentation("pending"), { icon: "CircleDashed", tone: "warning" });
    assert.deepEqual(checkPresentation("neutral"), { icon: "CircleMinus", tone: "muted" });
  });
});

describe("checksRingSvg", () => {
  it("draws one arc per part from 12 o'clock over the track", () => {
    const svg = checksRingSvg(
      [
        { color: "#d00", count: 1 },
        { color: "#c90", count: 1 },
        { color: "#0a0", count: 2 },
      ],
      "#eee",
    );
    assert.equal(findSvgIconProblem(svg), null);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><g transform="rotate(-90 10 10)">'));
    assert.ok(svg.includes('stroke="#eee" stroke-width="3"/>'));
    // r 8.5: circumference 53.41; a quarter is 13.35, less the 2 gap.
    assert.ok(svg.includes('stroke="#d00" stroke-width="3" stroke-dasharray="11.35 42.06" stroke-dashoffset="0"/>'));
    assert.ok(svg.includes('stroke="#c90" stroke-width="3" stroke-dasharray="11.35 42.06" stroke-dashoffset="-13.35"/>'));
    assert.ok(svg.includes('stroke="#0a0" stroke-width="3" stroke-dasharray="24.7 28.7" stroke-dashoffset="-26.7"/>'));
    assert.ok(!/<style|var\(|currentColor/u.test(svg));
  });

  it("closes the ring for one part and leaves the track alone for none", () => {
    const full = checksRingSvg([{ color: "#0a0", count: 3 }, { color: "#d00", count: 0 }], "#eee");
    assert.ok(full.includes('stroke="#0a0" stroke-width="3" stroke-dasharray="53.41 0" stroke-dashoffset="0"/>'));
    assert.ok(!full.includes("#d00"));
    assert.equal(checksRingSvg([], "#eee").match(/<circle/gu)?.length, 1);
  });
});
