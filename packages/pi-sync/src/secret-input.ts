import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	type Focusable,
	Key,
	type KeybindingsManager,
	matchesKey,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { runCustomInteraction } from "@narumitw/pi-tui-kit";

const MASK = "•";

export async function promptSecret(
	ctx: ExtensionCommandContext,
	title: string,
	options: { required?: boolean; signal?: AbortSignal } = { required: true },
) {
	if (ctx.mode !== "tui" || options.signal?.aborted) return undefined;
	const result = await runCustomInteraction<string | undefined>(ctx, {
		signal: options.signal,
		isCurrent: () => !options.signal?.aborted,
		create: ({ tui, theme, keybindings, complete }) => {
			const heading = new Text("", 0, 0);
			const hint = new Text("", 0, 0);
			const submitKey = keybindingText(keybindings, "tui.input.submit", "enter");
			const cancelKey = keybindingText(keybindings, "tui.select.cancel", "esc", ["ctrl+c"]);
			const applyTheme = () => {
				heading.setText(theme.fg("accent", theme.bold(title)));
				hint.setText(theme.fg("dim", `${submitKey} save • ${cancelKey} cancel • Input is hidden`));
			};
			applyTheme();
			const input = new MaskedInput(keybindings);
			const component: Focusable & {
				render(width: number): string[];
				invalidate(): void;
				handleInput(data: string): void;
				dispose(): void;
			} = {
				get focused() {
					return input.focused;
				},
				set focused(focused: boolean) {
					input.focused = focused;
				},
				render(width: number) {
					const safeWidth = Math.max(1, width);
					return [
						...heading.render(safeWidth),
						...input.render(safeWidth),
						...hint.render(safeWidth),
					].map((line) => truncateToWidth(line, safeWidth));
				},
				invalidate() {
					applyTheme();
					heading.invalidate();
					input.invalidate();
					hint.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, Key.ctrl("c")) || keybindings.matches(data, "tui.select.cancel")) {
						complete(undefined);
					} else if (keybindings.matches(data, "tui.input.submit")) complete(input.getValue());
					else input.handleInput(data);
					tui.requestRender();
				},
				dispose() {
					input.clear();
				},
			};
			return component;
		},
	});
	if (result.kind === "error") throw result.error;
	if (result.kind !== "completed" || result.value === undefined) return undefined;
	const value = result.value;
	if (options.required !== false && value.length === 0) {
		ctx.ui.notify(`${title} is required.`, "warning");
		return undefined;
	}
	return value;
}

class MaskedInput implements Focusable {
	focused = false;
	private value: string[] = [];
	private cursor = 0;
	private paste = "";
	private pasting = false;

	constructor(private readonly keybindings: KeybindingsManager) {}

	getValue() {
		return this.value.join("");
	}

	handleInput(data: string) {
		if (data.includes("\u001b[200~")) {
			this.pasting = true;
			this.paste = "";
			data = data.replace("\u001b[200~", "");
		}
		if (this.pasting) {
			this.paste += data;
			const end = this.paste.indexOf("\u001b[201~");
			if (end < 0) return;
			const pasted = this.paste
				.slice(0, end)
				.replace(/[\r\n]/gu, "")
				.replace(/\t/gu, "    ");
			this.insert(pasted);
			const remaining = this.paste.slice(end + 6);
			this.paste = "";
			this.pasting = false;
			if (remaining) this.handleInput(remaining);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
			if (this.cursor > 0) this.value.splice(--this.cursor, 1);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteCharForward")) {
			if (this.cursor < this.value.length) this.value.splice(this.cursor, 1);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			this.cursor = Math.min(this.value.length, this.cursor + 1);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) {
			this.cursor = 0;
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLineEnd")) {
			this.cursor = this.value.length;
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteToLineStart")) {
			this.value.splice(0, this.cursor);
			this.cursor = 0;
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteToLineEnd")) {
			this.value.splice(this.cursor);
			return;
		}
		const printable = decodeKittyPrintable(data) ?? data;
		if (!hasControlCharacter(printable)) this.insert(printable);
	}

	render(width: number) {
		const prompt = "> ";
		const available = width - prompt.length;
		if (available <= 0) return [truncateToWidth(prompt, Math.max(1, width))];
		const contentWidth = Math.max(0, available - 1);
		let start = 0;
		if (this.value.length > contentWidth) {
			start = Math.max(
				0,
				Math.min(this.cursor - Math.floor(contentWidth / 2), this.value.length - contentWidth),
			);
		}
		const end = Math.min(this.value.length, start + contentWidth);
		const visibleCursor = Math.max(0, Math.min(this.cursor - start, end - start));
		const masks = Array.from({ length: end - start }, () => MASK);
		const before = masks.slice(0, visibleCursor).join("");
		const atCursor = visibleCursor < masks.length ? MASK : " ";
		const after = masks.slice(visibleCursor + (visibleCursor < masks.length ? 1 : 0)).join("");
		const marker = this.focused ? CURSOR_MARKER : "";
		const line = `${prompt}${before}${marker}\u001b[7m${atCursor}\u001b[27m${after}`;
		return [truncateToWidth(line, width, "")];
	}

	invalidate() {}

	clear() {
		this.value.fill("");
		this.value = [];
		this.paste = "";
		this.cursor = 0;
		this.pasting = false;
	}

	private insert(value: string) {
		const characters = Array.from(value);
		this.value.splice(this.cursor, 0, ...characters);
		this.cursor += characters.length;
	}
}

function keybindingText(
	keybindings: Pick<KeybindingsManager, "getKeys">,
	binding: Parameters<KeybindingsManager["getKeys"]>[0],
	fallback: string,
	additionalKeys: readonly string[] = [],
) {
	const keys = [...new Set([...keybindings.getKeys(binding), ...additionalKeys])]
		.map(String)
		.map((key) => {
			if (key === "return") return "enter";
			if (key === "escape") return "esc";
			return hasControlCharacter(key) ? "" : key;
		})
		.filter(Boolean);
	return keys.join("/") || fallback;
}

function hasControlCharacter(value: string) {
	return [...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || (code >= 0x7f && code <= 0x9f);
	});
}
