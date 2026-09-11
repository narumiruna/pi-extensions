export type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "purple"
  | "cyan"
  | "white"
  | "bright-black"
  | "bright-red"
  | "bright-green"
  | "bright-yellow"
  | "bright-blue"
  | "bright-purple"
  | "bright-cyan"
  | "bright-white";

export type ColorSpec =
  | { kind: "named"; name: NamedColor }
  | { kind: "fixed"; value: number }
  | { kind: "rgb"; red: number; green: number; blue: number };

export type PreviousColorSource = "foreground" | "background";

export interface TextStyle {
  foreground?: ColorSpec;
  background?: ColorSpec;
  foregroundPrevious?: PreviousColorSource;
  backgroundPrevious?: PreviousColorSource;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dimmed?: boolean;
  inverted?: boolean;
  blink?: boolean;
  hidden?: boolean;
  strikethrough?: boolean;
}

export type StyleParseResult = { valid: true; style: TextStyle | undefined } | { valid: false; style: undefined };

export interface StyledChunk {
  text: string;
  style?: TextStyle;
}

export interface FillChunk {
  type: "fill";
  pattern: readonly StyledChunk[];
}

export type LayoutChunk = StyledChunk | FillChunk;

export function isFillChunk(chunk: LayoutChunk): chunk is FillChunk {
  return "type" in chunk && chunk.type === "fill";
}

export type ColorPalette = Readonly<Record<string, string>>;

const NAMED_COLORS = new Set<NamedColor>([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-purple",
  "bright-cyan",
  "bright-white",
]);

const FOREGROUND_CODES: Record<NamedColor, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  purple: 35,
  cyan: 36,
  white: 37,
  "bright-black": 90,
  "bright-red": 91,
  "bright-green": 92,
  "bright-yellow": 93,
  "bright-blue": 94,
  "bright-purple": 95,
  "bright-cyan": 96,
  "bright-white": 97,
};

export function isValidStyle(styleString: string, palette: ColorPalette = {}): boolean {
  return parseStyleResult(styleString, palette).valid;
}

export function parseStyleResult(styleString: string, palette: ColorPalette = {}): StyleParseResult {
  const tokens = styleString.split(/\s+/u).filter(Boolean).map(normalizeStyleToken);
  if (tokens.some(({ token, foreground }) => foreground && token === "none")) {
    return { valid: true, style: undefined };
  }

  const style: TextStyle = {};
  for (const { token, foreground } of tokens) {
    if (applyModifier(style, token)) continue;
    if (token === "prev_fg" || token === "prev_bg") {
      const source = token === "prev_fg" ? "foreground" : "background";
      if (foreground) style.foregroundPrevious = source;
      else style.backgroundPrevious = source;
      continue;
    }
    const color = parseColor(token, palette);
    if (!foreground && !color) {
      delete style.background;
      continue;
    }
    if (!color) return { valid: false, style: undefined };
    if (foreground) style.foreground = color;
    else style.background = color;
  }
  return { valid: true, style };
}

export function parseStyle(styleString: string, palette: ColorPalette = {}): TextStyle | undefined {
  return parseStyleResult(styleString, palette).style;
}

function normalizeStyleToken(rawToken: string): { token: string; foreground: boolean } {
  let token = rawToken.toLowerCase();
  if (token.startsWith("fg:")) {
    return { token: token.replace(/^(?:fg:)+/u, ""), foreground: true };
  }
  if (token.startsWith("bg:")) {
    token = token.replace(/^(?:bg:)+/u, "");
    return { token, foreground: false };
  }
  return { token, foreground: true };
}

function applyModifier(style: TextStyle, token: string): boolean {
  switch (token) {
    case "bold":
      style.bold = true;
      return true;
    case "italic":
      style.italic = true;
      return true;
    case "underline":
      style.underline = true;
      return true;
    case "dimmed":
      style.dimmed = true;
      return true;
    case "inverted":
      style.inverted = true;
      return true;
    case "blink":
      style.blink = true;
      return true;
    case "hidden":
      style.hidden = true;
      return true;
    case "strikethrough":
      style.strikethrough = true;
      return true;
    default:
      return false;
  }
}

export function parseColor(token: string, palette: ColorPalette = {}): ColorSpec | undefined {
  const paletteValue = Object.hasOwn(palette, token) ? palette[token] : undefined;
  if (paletteValue !== undefined) return parseColor(paletteValue.toLowerCase(), {});
  if (NAMED_COLORS.has(token as NamedColor)) {
    return { kind: "named", name: token as NamedColor };
  }
  if (/^\d{1,3}$/u.test(token)) {
    const value = Number(token);
    return value <= 255 ? { kind: "fixed", value } : undefined;
  }
  const rgb = /^#([0-9a-f]{6})$/iu.exec(token);
  if (!rgb?.[1]) return undefined;
  return {
    kind: "rgb",
    red: Number.parseInt(rgb[1].slice(0, 2), 16),
    green: Number.parseInt(rgb[1].slice(2, 4), 16),
    blue: Number.parseInt(rgb[1].slice(4, 6), 16),
  };
}

interface ResolvedStyle
  extends Omit<TextStyle, "foreground" | "background" | "foregroundPrevious" | "backgroundPrevious"> {
  foreground?: ColorSpec;
  background?: ColorSpec;
}

export function renderChunksToAnsi(chunks: readonly LayoutChunk[], trueColor = true): string {
  const runs: Array<{ text: string; style: ResolvedStyle }> = [];
  let previous: ResolvedStyle | undefined;
  for (const chunk of chunks) {
    if (isFillChunk(chunk)) continue;
    const style = resolveStyle(chunk.style, previous);
    const last = runs.at(-1);
    if (chunk.text && last && stylesEqual(last.style, style)) last.text += chunk.text;
    else if (chunk.text) runs.push({ text: chunk.text, style });
    previous = style;
  }
  return runs
    .map(({ text, style }) => {
      const codes = ansiCodes(style, trueColor);
      return codes.length > 0 ? `\u001b[${codes.join(";")}m${text}\u001b[0m` : text;
    })
    .join("");
}

function stylesEqual(left: ResolvedStyle, right: ResolvedStyle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveStyle(style: TextStyle | undefined, previous: ResolvedStyle | undefined): ResolvedStyle {
  if (!style) return {};
  const { foregroundPrevious, backgroundPrevious, ...resolved } = style;
  return {
    ...resolved,
    foreground: resolveColor(style.foreground, foregroundPrevious, previous),
    background: resolveColor(style.background, backgroundPrevious, previous),
  };
}

function resolveColor(
  fallback: ColorSpec | undefined,
  source: PreviousColorSource | undefined,
  previous: ResolvedStyle | undefined,
): ColorSpec | undefined {
  if (!source || !previous) return fallback;
  return source === "foreground" ? previous.foreground : previous.background;
}

function ansiCodes(style: ResolvedStyle, trueColor: boolean): string[] {
  const codes: string[] = [];
  if (style.foreground) codes.push(...colorCodes(style.foreground, false, trueColor));
  if (style.background) codes.push(...colorCodes(style.background, true, trueColor));
  if (style.bold) codes.push("1");
  if (style.dimmed) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.blink) codes.push("5");
  if (style.inverted) codes.push("7");
  if (style.hidden) codes.push("8");
  if (style.strikethrough) codes.push("9");
  return codes;
}

function colorCodes(color: ColorSpec, background: boolean, trueColor: boolean): string[] {
  if (color.kind === "named") {
    const foreground = FOREGROUND_CODES[color.name];
    return [`${background ? foreground + 10 : foreground}`];
  }
  if (color.kind === "fixed") return [background ? "48" : "38", "5", `${color.value}`];
  if (!trueColor) {
    return [background ? "48" : "38", "5", `${rgbToAnsi256(color.red, color.green, color.blue)}`];
  }
  return [background ? "48" : "38", "2", `${color.red}`, `${color.green}`, `${color.blue}`];
}

function rgbToAnsi256(red: number, green: number, blue: number): number {
  const channels = [red, green, blue].map((value) => Math.round((value / 255) * 5));
  return 16 + 36 * (channels[0] ?? 0) + 6 * (channels[1] ?? 0) + (channels[2] ?? 0);
}
