export const REVIEW_TEXT = [
  "Exact text sample",
  "",
  "  Leading spaces stay visible.",
  "\tA tab starts this line.",
  "Trailing spaces stay here.  ",
  "",
  "Search for sample to inspect literal matches.",
].join("\n");

export const REVIEW_CODE = [
  "interface DemoNote {",
  "  text: string;",
  "}",
  "",
  "export function formatNote(note: DemoNote): string {",
  '  return "Demo: " + note.text.trim();',
  "}",
  "",
].join("\n");

export const REVIEW_MARKDOWN = [
  "# Review example",
  "",
  "This read-only document shows **Markdown**, a flowchart, and LaTeX.",
  "Search for review to inspect literal matches in the displayed document.",
  "",
  "## Flowchart",
  "",
  "```mermaid",
  "flowchart LR",
  "  Open --> Review",
  "  Review --> Close",
  "```",
  "",
  "## Formula",
  "",
  "Inline math: $E = mc^2$.",
  "",
  "$$",
  "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
  "$$",
  "",
].join("\n");
