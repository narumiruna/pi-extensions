import { spawn } from "node:child_process";
import {
	copyToClipboard as copyToHostClipboard,
	type ExtensionCommandContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	isKeyRelease,
	Key,
	matchesKey,
	type OverlayHandle,
	type TUI,
	TuiAltScreen,
	type TuiInputListener,
	type TuiInputListenerResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { sanitizeSingleLine } from "./text.js";

type BtwCustomOptions = Parameters<ExtensionCommandContext["ui"]["custom"]>[1];
type BtwCustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

type BtwFullscreenTui = TUI & {
	flash?: (message: string, durationMs?: number) => void;
	setLayoutRoot(component: Component | undefined): void;
	addInputListenerBeforeViewport?(listener: TuiInputListener): () => void;
};

export interface BtwFullscreenLayoutComponent extends Component {
	getFullscreenLayout(): Component;
}

export type BtwFullscreenTuiFactory = (parent: TUI, theme: Theme) => BtwFullscreenTui;

export interface BtwFullscreenDependencies {
	createTui?: BtwFullscreenTuiFactory;
	openUrl?: (url: string) => void;
	copyToClipboard?: (text: string) => Promise<void>;
}

export type RunBtwFullscreen = <T>(
	ctx: ExtensionCommandContext,
	run: (ctx: ExtensionCommandContext) => Promise<T>,
) => Promise<T>;

type FullscreenOutcome<T> = { kind: "completed"; value: T } | { kind: "failed"; error: unknown };

class FullscreenUiDisposedError extends Error {
	constructor() {
		super("The dedicated pi-btw UI was disposed.");
		this.name = "FullscreenUiDisposedError";
	}
}

export async function runBtwFullscreen<T>(
	ctx: ExtensionCommandContext,
	run: (ctx: ExtensionCommandContext) => Promise<T>,
	dependencies: BtwFullscreenDependencies = {},
): Promise<T> {
	const createTui =
		dependencies.createTui ??
		((parent: TUI, theme: Theme) =>
			createBtwFullscreenTui(
				parent,
				theme,
				dependencies.openUrl ?? openUrlInBrowser,
				dependencies.copyToClipboard ?? copyToHostClipboard,
			));
	let liveEditorText = ctx.ui.getEditorText();
	let restoreEditor = false;
	let host: BtwFullscreenHost<T> | undefined;
	const outcome = await ctx.ui.custom<FullscreenOutcome<T>>(
		(parent, theme, keybindings, done) => {
			host = new BtwFullscreenHost(
				parent,
				theme,
				keybindings,
				ctx,
				run,
				(value) => {
					try {
						liveEditorText = ctx.ui.getEditorText();
						restoreEditor = true;
					} catch {
						// A replaced session owns a different editor and must not receive stale text.
					}
					done(value);
				},
				createTui,
			);
			return host;
		},
		{
			overlay: true,
			onHandle: (handle) => host?.setParentOverlay(handle),
		},
	);
	if (restoreEditor) {
		try {
			if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
		} catch {
			// A replaced session owns a different editor and must not receive stale restoration.
		}
	}
	if (outcome.kind === "failed") throw outcome.error;
	return outcome.value;
}

type BtwInputListeners = {
	beforeViewport: Set<TuiInputListener>;
	regular: Set<TuiInputListener>;
};

const btwInputListeners = new WeakMap<BtwTuiAltScreen, BtwInputListeners>();

function dispatchBtwInput(listeners: BtwInputListeners, data: string): TuiInputListenerResult {
	let current = data;
	for (const group of [listeners.beforeViewport, listeners.regular]) {
		for (const listener of group) {
			const result = listener(current);
			if (result?.consume) return result;
			if (result?.data !== undefined) current = result.data;
		}
	}
	return current === data ? undefined : { data: current };
}

class BtwTuiAltScreen extends TuiAltScreen {
	override addInputListener(listener: TuiInputListener): () => void {
		let listeners = btwInputListeners.get(this);
		if (!listeners) {
			const registeredListeners: BtwInputListeners = {
				beforeViewport: new Set(),
				regular: new Set(),
			};
			btwInputListeners.set(this, registeredListeners);
			super.addInputListener((data) => dispatchBtwInput(registeredListeners, data));
			listeners = registeredListeners;
		}
		listeners.regular.add(listener);
		return () => listeners.regular.delete(listener);
	}

	addInputListenerBeforeViewport(listener: TuiInputListener): () => void {
		const listeners = btwInputListeners.get(this);
		if (!listeners) return super.addInputListener(listener);
		listeners.beforeViewport.add(listener);
		return () => listeners.beforeViewport.delete(listener);
	}

	override removeInputListener(listener: TuiInputListener): void {
		const listeners = btwInputListeners.get(this);
		if (!listeners) {
			super.removeInputListener(listener);
			return;
		}
		listeners.beforeViewport.delete(listener);
		listeners.regular.delete(listener);
	}
}

function createBtwFullscreenTui(
	parent: TUI,
	theme: Theme,
	openUrl: (url: string) => void,
	copyToClipboard: (text: string) => Promise<void>,
): BtwFullscreenTui {
	const styleSearchMatch = (text: string) =>
		theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
	return new BtwTuiAltScreen(parent.terminal, parent.getShowHardwareCursor(), undefined, {
		mouse: true,
		searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
		searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
		openUrl,
		copySelection: async (text) => {
			try {
				await copyToClipboard(text);
				return true;
			} catch {
				return false;
			}
		},
	});
}

// Pi does not export its browser opener, so mirror its shell-free launcher for this isolated TUI.
function openUrlInBrowser(target: string): void {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];
	spawn(command, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}

class BtwFullscreenHost<T> implements Component {
	private fullscreen: BtwFullscreenTui | undefined;
	private parentOverlay: OverlayHandle | undefined;
	private cancelActiveCustom: (() => void) | undefined;
	private hardCancelActiveCustom: (() => void) | undefined;
	private removeHardCancelListener: (() => void) | undefined;
	private started = false;
	private disposed = false;
	private finished = false;
	private parentStopped = false;
	private parentRestarted = false;
	private fullscreenCreated = false;
	private fullscreenStopped = false;
	private cleanupError: unknown;

	constructor(
		private readonly parent: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly ctx: ExtensionCommandContext,
		private readonly run: (ctx: ExtensionCommandContext) => Promise<T>,
		private readonly done: (outcome: FullscreenOutcome<T>) => void,
		private readonly createTui: BtwFullscreenTuiFactory,
	) {
		queueMicrotask(() => void this.start());
	}

	setParentOverlay(overlay: OverlayHandle): void {
		this.parentOverlay = overlay;
	}

	render(width: number): string[] {
		return [truncateToWidth(this.theme.fg("muted", "Opening btw side thread…"), width)];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed || this.finished) return;
		this.disposed = true;
		this.cancelActiveCustom?.();
	}

	private async start(): Promise<void> {
		if (this.started || this.finished) return;
		this.started = true;
		let outcome: FullscreenOutcome<T>;
		try {
			if (this.disposed) throw new FullscreenUiDisposedError();
			this.parent.stop({ preserveScreen: true });
			this.parentStopped = true;
			if (this.disposed) throw new FullscreenUiDisposedError();
			this.fullscreen = this.createTui(this.parent, this.theme);
			this.fullscreenCreated = true;
			this.fullscreen.start();
			// Waiting for the custom promise would leave follow-up keys bound to the side TUI.
			const addHardCancelListener =
				this.fullscreen.addInputListenerBeforeViewport?.bind(this.fullscreen) ??
				this.fullscreen.addInputListener.bind(this.fullscreen);
			this.removeHardCancelListener = addHardCancelListener((data) => {
				if (isKeyRelease(data) || !matchesKey(data, Key.ctrl("c"))) return undefined;
				try {
					this.hardCancelActiveCustom?.();
				} finally {
					this.restoreParent();
				}
				return { consume: true };
			});
			outcome = { kind: "completed", value: await this.run(this.createContext()) };
		} catch (error) {
			outcome = { kind: "failed", error };
		}

		try {
			this.cancelActiveCustom?.();
		} catch (error) {
			this.cleanupError ??= error;
		}
		this.restoreParent();
		if (this.cleanupError !== undefined) outcome = { kind: "failed", error: this.cleanupError };
		this.finished = true;
		this.done(outcome);
	}

	private restoreParent(): void {
		this.removeHardCancelListener?.();
		this.removeHardCancelListener = undefined;
		if (this.fullscreenCreated && !this.fullscreenStopped) {
			this.fullscreenStopped = true;
			try {
				this.fullscreen?.stop({ preserveScreen: true });
			} catch (error) {
				this.cleanupError ??= error;
			}
		}
		if (!this.parentStopped || this.parentRestarted) return;
		const parentOverlay = this.parentOverlay;
		this.parentOverlay = undefined;
		try {
			parentOverlay?.setHidden(true);
		} catch (error) {
			this.cleanupError ??= error;
		}
		try {
			this.parent.start();
			this.parentRestarted = true;
			this.parent.renderNow(false);
		} catch (error) {
			this.cleanupError ??= error;
		}
	}

	private createContext(): ExtensionCommandContext {
		const ui = new Proxy(this.ctx.ui, {
			get: (target, property) => {
				if (property === "custom") {
					return <Value>(factory: BtwCustomFactory<Value>, options?: BtwCustomOptions) =>
						this.showCustom(factory, options);
				}
				if (property === "notify") {
					return (
						message: string,
						level?: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
					) => {
						target.notify(message, level);
						const display = sanitizeSingleLine(message);
						if (display) this.fullscreen?.flash?.(display);
					};
				}
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return new Proxy(this.ctx, {
			get: (target, property) => (property === "ui" ? ui : Reflect.get(target, property, target)),
		});
	}

	private showCustom<Value>(
		factory: BtwCustomFactory<Value>,
		options?: BtwCustomOptions,
	): Promise<Value> {
		const fullscreen = this.fullscreen;
		if (!fullscreen || this.disposed || this.finished) {
			return Promise.reject(new FullscreenUiDisposedError());
		}
		if (this.cancelActiveCustom) {
			return Promise.reject(new Error("pi-btw attempted to open overlapping custom UI."));
		}

		return new Promise<Value>((resolve, reject) => {
			let component: (Component & { dispose?(): void }) | undefined;
			let overlay: OverlayHandle | undefined;
			let mounted = false;
			let layoutMounted = false;
			let factorySettled = false;
			let closed = false;
			let promiseSettled = false;
			let componentDisposed = false;
			let pendingValue: Value | undefined;
			let hasPendingValue = false;

			const disposeComponent = () => {
				if (!component || componentDisposed) return;
				componentDisposed = true;
				try {
					component.dispose?.();
				} catch {
					// Cleanup must continue so terminal ownership is restored.
				}
			};
			const unmount = () => {
				let cleanupError: unknown;
				try {
					if (overlay) overlay.hide();
					else if (mounted && layoutMounted) fullscreen.setLayoutRoot(undefined);
					else if (mounted && component) fullscreen.removeChild(component);
				} catch (error) {
					cleanupError = error;
				}
				if (overlay || mounted) {
					try {
						fullscreen.setFocus(null);
						fullscreen.requestRender();
					} catch (error) {
						cleanupError ??= error;
					}
				}
				disposeComponent();
				if (cleanupError !== undefined) throw cleanupError;
			};
			const complete = () => {
				if (promiseSettled || !hasPendingValue) return;
				promiseSettled = true;
				this.cancelActiveCustom = undefined;
				this.hardCancelActiveCustom = undefined;
				if (!factorySettled) {
					resolve(pendingValue as Value);
					return;
				}
				try {
					unmount();
					resolve(pendingValue as Value);
				} catch (error) {
					reject(error);
				}
			};
			const close = (value: Value) => {
				if (closed || promiseSettled) return;
				closed = true;
				pendingValue = value;
				hasPendingValue = true;
				complete();
			};
			const fail = (error: unknown) => {
				if (promiseSettled) return;
				closed = true;
				promiseSettled = true;
				this.cancelActiveCustom = undefined;
				this.hardCancelActiveCustom = undefined;
				try {
					unmount();
					reject(error);
				} catch (cleanupError) {
					reject(cleanupError);
				}
			};
			this.cancelActiveCustom = () => {
				if (promiseSettled) return;
				disposeComponent();
				if (!promiseSettled) fail(new FullscreenUiDisposedError());
			};
			this.hardCancelActiveCustom = () => {
				if (promiseSettled) return;
				try {
					component?.handleInput?.("\u0003");
				} catch (error) {
					fail(error);
					return;
				}
				this.cancelActiveCustom?.();
			};

			let created: ReturnType<BtwCustomFactory<Value>>;
			try {
				created = factory(fullscreen, this.theme, this.keybindings, close);
			} catch (error) {
				factorySettled = true;
				fail(error);
				return;
			}
			Promise.resolve(created)
				.then((value) => {
					component = value;
					factorySettled = true;
					if (promiseSettled) {
						disposeComponent();
						return;
					}
					if (closed) {
						complete();
						return;
					}
					if (options?.overlay) {
						const overlayOptions =
							typeof options.overlayOptions === "function"
								? options.overlayOptions()
								: options.overlayOptions;
						overlay = fullscreen.showOverlay(component, overlayOptions);
						options.onHandle?.(overlay);
					} else {
						fullscreen.clear();
						mounted = true;
						if (isFullscreenLayoutComponent(component)) {
							layoutMounted = true;
							fullscreen.setLayoutRoot(component.getFullscreenLayout());
						} else {
							fullscreen.addChild(component);
						}
						fullscreen.setFocus(component);
						fullscreen.requestRender();
					}
				})
				.catch(fail);
		});
	}
}

function isFullscreenLayoutComponent(
	component: Component,
): component is BtwFullscreenLayoutComponent {
	return "getFullscreenLayout" in component && typeof component.getFullscreenLayout === "function";
}
