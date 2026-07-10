import type {
	AgentToolResult,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "chrome-devtools";
interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}
interface RenderTheme {
	bold(text: string): string;
	fg(color: string, text: string): string;
}
interface RenderComponent {
	invalidate(): void;
	render(width: number): string[];
}

export function renderToolCall(action: string) {
	return () => new PiTextComponent(`Chrome DevTools: ${action}`);
}

export function renderTextResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
) {
	const output = formatCollapsibleOutput(textContent(result), options);
	return new PiTextComponent(output.text, theme, output.color);
}

export function renderScreenshotResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
): RenderComponent {
	const output = formatCollapsibleOutput(screenshotTextContent(result), options);
	return new PiTextComponent(output.text, theme, output.color);
}

function textContent(result: AgentToolResult<unknown>) {
	return result.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n");
}

function screenshotTextContent(result: AgentToolResult<unknown>) {
	const text = textContent(result);
	if (text.trim()) return text;

	const details = result.details as { savedPath?: unknown; bytes?: unknown } | undefined;
	if (typeof details?.savedPath !== "string") return text;
	const bytes = typeof details.bytes === "number" ? ` (${details.bytes} bytes)` : "";
	return `Saved screenshot to ${details.savedPath}${bytes}`;
}

function formatCollapsibleOutput(
	text: string,
	options: ToolRenderResultOptions,
): { text: string; color?: string } {
	if (options.isPartial) return { text: "Running...", color: "warning" };
	if (options.expanded) return { text, color: "toolOutput" };

	return { text: "" };
}

class PiTextComponent implements RenderComponent {
	private text: string;
	private readonly theme?: RenderTheme;
	private readonly color?: string;

	constructor(text = "", theme?: RenderTheme, color?: string) {
		this.text = text;
		this.theme = theme;
		this.color = color;
	}

	setText(text: string) {
		this.text = text;
	}

	invalidate() {
		// Stateless renderer: no cached layout to invalidate.
	}

	render(width: number) {
		if (!this.text.trim()) return [];
		return this.text
			.replace(/\t/g, "   ")
			.split(/\r?\n/)
			.map((line) => {
				const truncatedLine = truncateLine(line, Math.max(1, width));
				return this.theme && this.color
					? this.theme.fg(this.color, truncatedLine)
					: truncatedLine;
			});
	}
}

function truncateLine(line: string, maxWidth: number) {
	return Array.from(line).slice(0, maxWidth).join("");
}

export async function withStatus<T>(ctx: StatusContext, status: string, callback: () => Promise<T>) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await callback();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

