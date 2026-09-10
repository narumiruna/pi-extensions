import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";

export type TuiHarnessKey =
	| "app.models.save"
	| "app.thinking.save"
	| "app.thinking.cycle"
	| "tui.input.tab"
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm"
	| "tui.select.cancel"
	| "tui.input.submit"
	| "ctrl+c"
	| "home"
	| "end";

export interface TuiHarnessOptions {
	width?: number;
	rows?: number;
	theme?: Pick<Theme, "fg" | "bold">;
	keybindings?: Pick<KeybindingsManager, "matches" | "getKeys">;
}

export interface TuiHarnessResize {
	width?: number;
	rows?: number;
}

export interface TuiHarness {
	readonly custom: ExtensionContext["ui"]["custom"];
	readonly openCount: number;
	readonly requestRenderCount: number;
	readonly isOpen: boolean;
	readonly isFocusable: boolean;
	readonly focused: boolean;
	readonly result: unknown;
	readonly resultPromise: Promise<unknown>;
	waitForOpen(): Promise<number>;
	render(width?: number): readonly string[];
	press(key: TuiHarnessKey): readonly string[];
	send(data: string): readonly string[];
	type(text: string): readonly string[];
	resize(size: TuiHarnessResize): readonly string[];
	invalidate(): void;
	setFocused(focused: boolean): void;
	waitForPending(): Promise<void>;
	dispose(): void;
}

interface RpcExpectedInput {
	title?: string;
	placeholder?: string;
}

interface RpcExpectedSelect {
	title?: string;
	options?: readonly string[];
}

export type RpcHarnessStep =
	| ({
			kind: "input";
			response: string | undefined;
			waitForAbort?: never;
	  } & RpcExpectedInput)
	| ({
			kind: "input";
			waitForAbort: true;
			response?: never;
	  } & RpcExpectedInput)
	| ({
			kind: "select";
			response: string | undefined;
			waitForAbort?: never;
	  } & RpcExpectedSelect)
	| ({
			kind: "select";
			waitForAbort: true;
			response?: never;
	  } & RpcExpectedSelect);

export interface RpcDialogRecord {
	readonly kind: "input" | "select";
	readonly title: string;
	readonly placeholder?: string;
	readonly options?: readonly string[];
	readonly signalWasAborted: boolean;
}

export interface RpcHarness {
	readonly ui: Pick<ExtensionContext["ui"], "input" | "select" | "custom">;
	readonly dialogs: readonly RpcDialogRecord[];
	readonly remainingSteps: number;
	waitForCall(): Promise<RpcDialogRecord>;
	assertConsumed(): void;
}
