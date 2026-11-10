import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demoteHeadings } from "./markdown.logic.ts";

const lines = (...text: string[]) => text.join("\n");

describe("demoteHeadings", () => {
  it("drops # and ## to h5, and ### and deeper to h6", () => {
    assert.equal(
      demoteHeadings(lines("# One", "## Two", "### Three", "#### Four", "###### Six", "   ## Indented", "#", "#hashtag", "####### seven")),
      lines("##### One", "##### Two", "###### Three", "###### Four", "###### Six", "   ##### Indented", "#####", "#hashtag", "####### seven"),
    );
  });

  it("leaves fenced code alone", () => {
    const body = lines("```md", "# not a heading", "Title", "===", "```", "# After", "~~~~", "## inside", "~~~", "still inside", "~~~~", "## Out");
    assert.equal(demoteHeadings(body), lines("```md", "# not a heading", "Title", "===", "```", "##### After", "~~~~", "## inside", "~~~", "still inside", "~~~~", "##### Out"));
    // An unclosed fence runs to the end.
    assert.equal(demoteHeadings(lines("```", "# a")), lines("```", "# a"));
    // A closing fence needs at least as many of the same character and nothing after it.
    assert.equal(demoteHeadings(lines("````", "```", "``` x", "# a", "````", "# b")), lines("````", "```", "``` x", "# a", "````", "##### b"));
  });

  it("turns setext headings into h5", () => {
    assert.equal(demoteHeadings(lines("Title", "=====", "", "Sub", "---", "text")), lines("##### Title", "", "##### Sub", "text"));
    assert.equal(demoteHeadings(lines("A long", "  title", "==")), "##### A long title");
    assert.equal(demoteHeadings(lines("intro", "", "Title", "-")), lines("intro", "", "##### Title"));
    assert.equal(demoteHeadings("Title\r\n===\r\nbody"), lines("##### Title", "body"));
  });

  it("keeps thematic breaks, tables and lists", () => {
    assert.equal(demoteHeadings(lines("text", "", "---", "more")), lines("text", "", "---", "more"));
    assert.equal(demoteHeadings(lines("a | b", "--- | ---", "1 | 2")), lines("a | b", "--- | ---", "1 | 2"));
    assert.equal(demoteHeadings(lines("- item", "---")), lines("- item", "---"));
    assert.equal(demoteHeadings(lines("para", "- item", "---")), lines("para", "- item", "---"));
    assert.equal(demoteHeadings(lines("> quote", "===")), lines("> quote", "==="));
    assert.equal(demoteHeadings(lines("", "    code", "---")), lines("", "    code", "---"));
    assert.equal(demoteHeadings(lines("text", "***")), lines("text", "***"));
  });
});
