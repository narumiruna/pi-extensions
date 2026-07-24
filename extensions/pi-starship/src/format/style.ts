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
	| { kind: "rgb"; red: number; green: number; blue: number }
	| { kind: "previous"; source: "foreground" | "background" };

export interface TextStyle {
	foreground?: ColorSpec;
	background?: ColorSpec;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	dimmed?: boolean;
	inverted?: boolean;
	blink?: boolean;
	hidden?: boolean;
	strikethrough?: boolean;
}

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
	for (const rawToken of styleString.split(/\s+/u).filter(Boolean)) {
		const token = rawToken.toLowerCase();
		if (token === "none" || token === "fg:none" || token === "bg:none") continue;
		const probe: TextStyle = {};
		if (applyModifier(probe, token)) continue;
		const colorToken = token.startsWith("fg:") || token.startsWith("bg:") ? token.slice(3) : token;
		if (!parseColor(colorToken, palette)) return false;
	}
	return true;
}

export function parseStyle(styleString: string, palette: ColorPalette = {}): TextStyle | undefined {
	const style: TextStyle = {};
	for (const rawToken of styleString.split(/\s+/u).filter(Boolean)) {
		const token = rawToken.toLowerCase();
		if (token === "none") return undefined;
		if (token === "fg:none") {
			delete style.foreground;
			continue;
		}
		if (applyModifier(style, token)) continue;

		const foreground = token.startsWith("fg:");
		const background = token.startsWith("bg:");
		const colorToken = foreground || background ? token.slice(3) : token;
		if (background && colorToken === "none") {
			delete style.background;
			continue;
		}
		const color = parseColor(colorToken, palette);
		if (!color) return undefined;
		if (background) style.background = color;
		else style.foreground = color;
	}
	return Object.keys(style).length > 0 ? style : undefined;
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
	if (token === "prev_fg") return { kind: "previous", source: "foreground" };
	if (token === "prev_bg") return { kind: "previous", source: "background" };
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

interface ResolvedStyle extends Omit<TextStyle, "foreground" | "background"> {
	foreground?: Exclude<ColorSpec, { kind: "previous" }>;
	background?: Exclude<ColorSpec, { kind: "previous" }>;
}

export function renderChunksToAnsi(chunks: readonly LayoutChunk[]): string {
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
			const codes = ansiCodes(style);
			return codes.length > 0 ? `\u001b[${codes.join(";")}m${text}\u001b[0m` : text;
		})
		.join("");
}

function stylesEqual(left: ResolvedStyle, right: ResolvedStyle): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function resolveStyle(
	style: TextStyle | undefined,
	previous: ResolvedStyle | undefined,
): ResolvedStyle {
	if (!style) return {};
	return {
		...style,
		foreground: resolveColor(style.foreground, previous),
		background: resolveColor(style.background, previous),
	};
}

function resolveColor(
	color: ColorSpec | undefined,
	previous: ResolvedStyle | undefined,
): ResolvedStyle["foreground"] {
	if (!color) return undefined;
	if (color.kind !== "previous") return color;
	return color.source === "foreground" ? previous?.foreground : previous?.background;
}

function ansiCodes(style: ResolvedStyle): string[] {
	const codes: string[] = [];
	if (style.foreground) codes.push(...colorCodes(style.foreground, false));
	if (style.background) codes.push(...colorCodes(style.background, true));
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

function colorCodes(
	color: Exclude<ColorSpec, { kind: "previous" }>,
	background: boolean,
): string[] {
	if (color.kind === "named") {
		const foreground = FOREGROUND_CODES[color.name];
		return [`${background ? foreground + 10 : foreground}`];
	}
	if (color.kind === "fixed") return [background ? "48" : "38", "5", `${color.value}`];
	return [background ? "48" : "38", "2", `${color.red}`, `${color.green}`, `${color.blue}`];
}
