import { Container, Key, Loader, matchesKey, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { HorizontalRule } from "../horizontal-rule.js";
import type { MenuKeybindings } from "./contracts.js";

interface TaskLoaderTheme {
	fg(color: "accent" | "border" | "dim" | "muted", text: string): string;
}

/** Cancellable loader composed from public Pi TUI primitives and callback-owned inputs. */
export class TaskLoader extends Container {
	private readonly loader: Loader;
	private readonly cancellable: boolean;
	private disposed = false;
	onAbort?: () => void;

	constructor(
		tui: TUI,
		theme: TaskLoaderTheme,
		private readonly keybindings: MenuKeybindings,
		message: string,
		options: { cancellable?: boolean } = {},
	) {
		super();
		this.cancellable = options.cancellable ?? true;
		const cancelHint = this.cancellable ? cancelKeyText(keybindings) : undefined;
		const borderColor = (text: string) => theme.fg("border", text);
		this.addChild(new HorizontalRule({ ruleStyle: borderColor }));
		this.loader = new Loader(
			tui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			message,
		);
		this.addChild(this.loader);
		if (cancelHint !== undefined) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", cancelHint) + theme.fg("muted", " cancel"), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new HorizontalRule({ ruleStyle: borderColor }));
	}

	handleInput(data: string): void {
		if (this.disposed || !this.cancellable) return;
		const matches = this.keybindings.matches;
		const cancelled =
			matchesKey(data, Key.ctrl("c")) ||
			(typeof matches === "function"
				? matches.call(this.keybindings, data, "tui.select.cancel")
				: matchesKey(data, Key.escape));
		if (cancelled) this.onAbort?.();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.loader.stop();
	}
}

function cancelKeyText(keybindings: MenuKeybindings): string {
	const getKeys = keybindings.getKeys;
	const configuredKeys =
		typeof getKeys === "function" ? getKeys.call(keybindings, "tui.select.cancel") : ["escape"];
	const keys = [...new Set([...configuredKeys, "ctrl+c"])];
	return keys.map(displayKey).join("/");
}

function displayKey(key: string): string {
	return key
		.split("+")
		.map((part) =>
			process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part,
		)
		.join("+");
}
