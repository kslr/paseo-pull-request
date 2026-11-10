// Prepares a pull request description for the host's Markdown view. Pure, so it is unit tested
// apart from the React Native views.

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const ATX = /^( {0,3})(#{1,6})(?=[ \t]|$)/u;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/u;
// Lines that start a block of their own, so a following underline is not a setext heading.
const NON_PARAGRAPH = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|<|\|)/u;

// The host renders h1–h4 larger than the 16px pull request title, so headings drop to h5 (# and
// ##) and h6 (### and deeper). Setext headings become ATX ones; fenced code is left alone.
export function demoteHeadings(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  let fence: { readonly char: string; readonly length: number } | null = null;
  // Where the current plain paragraph starts in `out`; null outside one.
  let paragraph: number | null = null;
  // Inside a list item, block quote or other block until the next blank line.
  let otherBlock = false;

  for (const line of lines) {
    if (fence) {
      out.push(line);
      const closing = FENCE.exec(line);
      if (closing && closing[1]!.charAt(0) === fence.char && closing[1]!.length >= fence.length && line.trim() === closing[1]) fence = null;
      continue;
    }
    if (line.trim() === "") {
      out.push(line);
      paragraph = null;
      otherBlock = false;
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening) {
      out.push(line);
      fence = { char: opening[1]!.charAt(0), length: opening[1]!.length };
      paragraph = null;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      out.push(`${atx[1]}${atx[2]!.length <= 2 ? "#####" : "######"}${line.slice(atx[0].length)}`);
      paragraph = null;
      continue;
    }
    const setext = SETEXT.exec(line);
    if (setext && paragraph !== null) {
      const text = out
        .splice(paragraph)
        .map((part) => part.trim())
        .join(" ");
      out.push(`##### ${text}`);
      paragraph = null;
      continue;
    }
    if (NON_PARAGRAPH.test(line) || (paragraph === null && /^(?: {4}|\t)/u.test(line))) {
      otherBlock = true;
      paragraph = null;
    } else if (paragraph === null && !otherBlock) paragraph = out.length;
    out.push(line);
  }
  return out.join("\n");
}
