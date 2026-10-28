import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { type FormatNode, formatVariables, parseFormat, renderFormat, styleVariables } from "../../format/formatter.js";
import { type ColorPalette, isFillChunk, type StyledChunk } from "../../format/style.js";

const MAX_TEMPLATE_LENGTH = 4_096;
const MAX_TEMPLATE_DEPTH = 16;

/** Status templates use the normal formatter, but cannot resolve other module data. */
export function renderStatusTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
  palette: ColorPalette,
): StyledChunk[] {
  const nodes = parseStatusTemplate(template, Object.keys(variables));
  return nodes
    ? renderFormat(nodes, { variables, palette }).filter(
        (chunk): chunk is StyledChunk => !isFillChunk(chunk) && chunk.text.length > 0,
      )
    : [];
}

export function validStatusTemplate(template: string, variables: readonly string[]): boolean {
  return parseStatusTemplate(template, variables) !== undefined;
}

function parseStatusTemplate(template: string, variables: readonly string[]): FormatNode[] | undefined {
  if (template.length > MAX_TEMPLATE_LENGTH) return undefined;
  const safe = sanitizeTerminalText(template);
  let depth = 0;
  for (let index = 0; index < safe.length; index += 1) {
    const character = safe[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "[" || character === "(") {
      if (++depth > MAX_TEMPLATE_DEPTH) return undefined;
    } else if (character === "]" || character === ")") {
      depth -= 1;
    }
  }
  try {
    const nodes = parseFormat(safe);
    if ([...formatVariables(nodes)].some((variable) => !variables.includes(variable))) return undefined;
    if (styleVariables(nodes).size > 0) return undefined;
    return nodes;
  } catch {
    return undefined;
  }
}

export function joinStatusTemplates(values: readonly (readonly StyledChunk[])[]): StyledChunk[] {
  const result: StyledChunk[] = [];
  for (const value of values) {
    if (value.length === 0) continue;
    if (result.length > 0) result.push({ text: " " });
    result.push(...value);
  }
  return result;
}
