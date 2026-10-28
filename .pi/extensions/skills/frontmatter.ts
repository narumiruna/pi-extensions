const KEY = "disable-model-invocation";
const KEY_PATTERN = `(?:disable-model-invocation|"disable-model-invocation"|'disable-model-invocation')`;
const KEY_LINE = new RegExp(String.raw`^${KEY_PATTERN}[ \t]*:`);
const BOOLEAN_LINE = new RegExp(
  String.raw`^(${KEY_PATTERN}[ \t]*:[ \t]*)(true|True|TRUE|false|False|FALSE)([ \t]*(?:[ \t]#.*)?)$`,
);

interface Line {
  start: number;
  fullEnd: number;
  text: string;
  newline: string;
}

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;

  while (start < content.length) {
    let end = start;
    while (end < content.length && content[end] !== "\n" && content[end] !== "\r") end += 1;

    let newline = "";
    if (content[end] === "\r" && content[end + 1] === "\n") newline = "\r\n";
    else if (content[end] === "\r" || content[end] === "\n") newline = content[end];

    const fullEnd = end + newline.length;
    lines.push({ start, fullEnd, text: content.slice(start, end), newline });
    start = fullEnd;
  }

  return lines;
}

function findFrontmatter(content: string): { lines: Line[]; closingIndex: number; newline: string } {
  const lines = splitLines(content);
  if (lines.length === 0) throw new Error("Skill file is empty");

  const firstLine = lines[0].text.replace(/^\uFEFF/, "");
  if (firstLine !== "---") throw new Error("Skill file must begin with a YAML frontmatter delimiter (---)");

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.text === "---");
  if (closingIndex < 0) throw new Error("Skill file has no closing YAML frontmatter delimiter (---)");

  return { lines, closingIndex, newline: lines[0].newline || "\n" };
}

/**
 * Edit only a simple top-level disable-model-invocation field without reformatting YAML.
 * Enabling removes the field to restore Pi's default. The writer must validate the original
 * and candidate with Pi: this line editor does not interpret escaped, explicit, or flow keys.
 */
export function setModelInvocation(content: string, enabled: boolean): string {
  const { lines, closingIndex, newline } = findFrontmatter(content);
  const matches = lines
    .slice(1, closingIndex)
    .filter((line) => !line.text.startsWith(" ") && !line.text.startsWith("\t") && KEY_LINE.test(line.text));

  if (matches.length > 1) throw new Error(`Skill frontmatter contains duplicate ${KEY} fields`);

  const existing = matches[0];
  if (!existing) {
    if (enabled) return content;
    const closing = lines[closingIndex];
    return `${content.slice(0, closing.start)}${KEY}: true${newline}${content.slice(closing.start)}`;
  }

  const parsed = BOOLEAN_LINE.exec(existing.text);
  if (!parsed) throw new Error(`${KEY} must be a simple boolean (true or false)`);

  if (enabled) {
    return `${content.slice(0, existing.start)}${content.slice(existing.fullEnd)}`;
  }
  if (parsed[2].toLowerCase() === "true") return content;

  const replacement = `${parsed[1]}true${parsed[3]}${existing.newline}`;
  return `${content.slice(0, existing.start)}${replacement}${content.slice(existing.fullEnd)}`;
}
