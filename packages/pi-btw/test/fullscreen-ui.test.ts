import assert from "node:assert/strict";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	type Terminal,
	type TUI,
	TUI_KEYBINDINGS,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type BtwFullscreenTuiFactory, runBtwFullscreen } from "../src/fullscreen-ui.js";

interface FakeComponent extends Component {
	dispose(): void;
}

function createHarness(options: { fullscreenStopError?: Error; layoutMountError?: Error } = {}) {
	const events: string[] = [];
	let outerComponent: FakeComponent | undefined;
	let outerDone: ((value: unknown) => void) | undefined;
	let editorText = "main draft";
	const parent = {
		mode: "regular",
		terminal: { rows: 24, columns: 80 },
		getShowHardwareCursor: () => false,
		stop: (options?: { preserveScreen?: boolean }) => {
			events.push(`parent.stop:${String(options?.preserveScreen)}`);
		},
		start: () => events.push("parent.start"),
		renderNow: (force?: boolean) => events.push(`parent.renderNow:${String(force)}`),
		requestRender: (force?: boolean) => events.push(`parent.render:${String(force)}`),
	} as unknown as TUI;
	let active: Component | undefined;
	const fullscreen = {
		mode: "fullscreen",
		terminal: parent.terminal,
		children: [] as Component[],
		clear() {
			events.push("fullscreen.clear");
			active = undefined;
		},
		addChild(component: Component) {
			events.push("fullscreen.add");
			active = component;
		},
		removeChild(component: Component) {
			events.push("fullscreen.remove");
			if (active === component) active = undefined;
		},
		setLayoutRoot(component: Component | undefined) {
			events.push(component ? "fullscreen.layout" : "fullscreen.layout.clear");
			active = component;
			if (component && options.layoutMountError) throw options.layoutMountError;
		},
		setFocus(component: Component | null) {
			events.push(component ? "fullscreen.focus" : "fullscreen.unfocus");
		},
		start() {
			events.push("fullscreen.start");
		},
		stop(stopOptions?: { preserveScreen?: boolean }) {
			events.push(`fullscreen.stop:${String(stopOptions?.preserveScreen)}`);
			if (options.fullscreenStopError) throw options.fullscreenStopError;
		},
		requestRender() {
			events.push("fullscreen.render");
		},
		addInputListener() {
			return () => {};
		},
		showOverlay() {
			throw new Error("overlay was not expected");
		},
		flash(message: string) {
			events.push(`fullscreen.flash:${message}`);
		},
	} as unknown as ReturnType<BtwFullscreenTuiFactory>;
	const createTui: BtwFullscreenTuiFactory = () => fullscreen;
	const notifications: string[] = [];
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => FakeComponent) => {
				const savedEditorText = editorText;
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				outerComponent = factory(
					parent as never,
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					} as never,
					{} as never,
					((value: unknown) => outerDone?.(value)) as never,
				);
				const value = await result;
				editorText = savedEditorText;
				return value;
			},
			notify(message: string) {
				notifications.push(message);
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		},
	} as never;
	return {
		ctx,
		createTui,
		events,
		notifications,
		get outerComponent() {
			return outerComponent;
		},
		get editorText() {
			return editorText;
		},
	};
}

function immediateComponent(done: (value: string) => void, events: string[]): FakeComponent {
	done("side result");
	return {
		render: () => ["side"],
		invalidate() {},
		dispose() {
			events.push("component.dispose");
		},
	};
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

class InputHandoffTerminal implements Terminal {
	readonly columns = 80;
	readonly rows = 12;
	readonly kittyProtocolActive = false;
	private inputHandler: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void): void {
		this.inputHandler = onInput;
	}

	stop(): void {
		this.inputHandler = undefined;
	}

	send(data: string): void {
		this.inputHandler?.(data);
	}

	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class MainInput implements Component, Focusable {
	focused = false;
	text = "";

	render(): string[] {
		return [this.text];
	}

	handleInput(data: string): void {
		if (data.charCodeAt(0) >= 32) this.text += data;
	}

	invalidate(): void {}
}

function createInputHandoffHarness() {
	const terminal = new InputHandoffTerminal();
	const parent = new TuiMainScreen(terminal, false);
	const editorContainer = new Container();
	const mainInput = new MainInput();
	editorContainer.addChild(mainInput);
	parent.addChild(editorContainer);
	parent.setFocus(mainInput);
	parent.start();

	const ctx = {
		ui: {
			custom: <Value>(
				factory: (
					tui: TUI,
					theme: unknown,
					keybindings: unknown,
					done: (value: Value) => void,
				) => Component & { dispose?(): void },
				options?: {
					overlay?: boolean;
					onHandle?: (handle: ReturnType<TUI["showOverlay"]>) => void;
				},
			) =>
				new Promise<Value>((resolve) => {
					assert.equal(options?.overlay, true);
					let component: (Component & { dispose?(): void }) | undefined;
					let closed = false;
					const done = (value: Value) => {
						if (closed) return;
						closed = true;
						parent.hideOverlay();
						component?.dispose?.();
						resolve(value);
					};
					component = factory(
						parent,
						{
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text,
							underline: (text: string) => text,
							inverse: (text: string) => text,
							bold: (text: string) => text,
						},
						{},
						done,
					);
					const overlay = parent.showOverlay(component);
					options.onHandle?.(overlay);
				}),
			getEditorText: () => mainInput.text,
			setEditorText: (value: string) => {
				mainInput.text = value;
			},
		},
	} as never;
	return { ctx, mainInput, parent, terminal };
}

function createNativeFullscreenHarness() {
	const events: string[] = [];
	const writes: string[] = [];
	let handleInput: ((data: string) => void) | undefined;
	const terminal = {
		columns: 80,
		rows: 12,
		start(onInput: (data: string) => void) {
			handleInput = onInput;
		},
		stop() {},
		write(data: string) {
			writes.push(data);
		},
		hideCursor() {},
		showCursor() {},
	} as never;
	const parent = {
		mode: "regular",
		terminal,
		getShowHardwareCursor: () => false,
		stop(options?: { preserveScreen?: boolean }) {
			events.push(`parent.stop:${String(options?.preserveScreen)}`);
		},
		start() {
			events.push("parent.start");
		},
		renderNow(force?: boolean) {
			events.push(`parent.renderNow:${String(force)}`);
		},
		requestRender() {},
	} as unknown as TUI;
	let outerComponent: FakeComponent | undefined;
	let outerDone: ((value: unknown) => void) | undefined;
	let editorText = "main draft";
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		bold: (text: string) => text,
	};
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => FakeComponent) => {
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				outerComponent = factory(
					parent as never,
					theme as never,
					{} as never,
					((value: unknown) => outerDone?.(value)) as never,
				);
				return result;
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		},
	} as never;
	return {
		ctx,
		events,
		writes,
		get outerComponent() {
			return outerComponent;
		},
		get input() {
			assert.ok(handleInput);
			return handleInput;
		},
	};
}

async function startClipboardSelection(copy: (text: string) => Promise<void>) {
	const harness = createNativeFullscreenHarness();
	let sideTui: TUI | undefined;
	let closeSide: (() => void) | undefined;
	const running = runBtwFullscreen(
		harness.ctx,
		(fullscreenCtx) =>
			fullscreenCtx.ui.custom<"closed">((tui, _theme, _keys, done) => {
				sideTui = tui;
				closeSide = () => done("closed");
				return {
					render: () => ["\u001b[31mcopy me\u001b[39m"],
					invalidate() {},
					dispose() {},
				};
			}),
		{ copyToClipboard: copy },
	);
	await flushAsyncWork();
	assert.ok(sideTui);
	assert.ok(closeSide);
	sideTui.renderNow(true);
	harness.writes.length = 0;
	harness.input("\u001b[<0;1;1M");
	harness.input("\u001b[<0;7;1m");
	return { harness, running, sideTui, closeSide };
}

test("Ctrl+C hands input back without closing another parent overlay", async () => {
	const harness = createInputHandoffHarness();
	const existingOverlay = harness.parent.showOverlay(
		{
			render: () => ["existing overlay"],
			invalidate() {},
		},
		{ nonCapturing: true },
	);
	try {
		const running = runBtwFullscreen(harness.ctx, (ctx) =>
			ctx.ui.custom<"closed">((_tui, _theme, _keybindings, done) => ({
				focused: false,
				render: () => ["side thread"],
				handleInput(data: string) {
					if (data === "\u0003") done("closed");
				},
				invalidate() {},
			})),
		);
		await flushAsyncWork();

		harness.terminal.send("\u0003");
		harness.terminal.send("x");

		assert.equal(await running, "closed");
		assert.equal(harness.mainInput.text, "x");
		assert.equal(harness.parent.hasOverlay(), true);
	} finally {
		existingOverlay.hide();
		harness.parent.stop();
	}
});

test("Ctrl+C cancels the side flow when transcript search owns focus", async () => {
	const harness = createInputHandoffHarness();
	const ctrlShiftF = "\u001b[102;6u";
	let sideTui: TUI | undefined;
	let closeSide: (() => void) | undefined;
	let settled = false;
	const running = runBtwFullscreen(harness.ctx, (ctx) =>
		ctx.ui.custom<"closed">((tui, _theme, _keybindings, done) => {
			sideTui = tui;
			closeSide = () => done("closed");
			return {
				focused: false,
				render: () => ["side thread"],
				invalidate() {},
			};
		}),
	);
	const observed = running.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	try {
		await flushAsyncWork();
		assert.ok(sideTui);

		harness.terminal.send(ctrlShiftF);
		assert.equal(sideTui.hasOverlay(), true);
		harness.terminal.send("\u0003");
		harness.terminal.send("x");
		await flushAsyncWork();

		assert.equal(settled, true);
		assert.equal(harness.mainInput.text, "x");
	} finally {
		closeSide?.();
		await observed;
		harness.parent.stop();
	}
});

test("Ctrl+C hard-cancels the side root before a remapped search close", async (t) => {
	const previousKeybindings = getKeybindings();
	t.onTestFinished(() => setKeybindings(previousKeybindings));
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.altScreen.searchClose": "ctrl+c",
		}),
	);
	const harness = createInputHandoffHarness();
	let sideTui: TUI | undefined;
	let closeSide: (() => void) | undefined;
	let sideCancelCount = 0;
	const running = runBtwFullscreen(harness.ctx, (ctx) =>
		ctx.ui.custom<"closed">((tui, _theme, _keybindings, done) => {
			sideTui = tui;
			closeSide = () => done("closed");
			return {
				focused: false,
				render: () => ["side thread"],
				handleInput(data: string) {
					if (data !== "\u0003") return;
					sideCancelCount += 1;
					done("closed");
				},
				invalidate() {},
			};
		}),
	);
	try {
		await flushAsyncWork();
		assert.ok(sideTui);
		const searchableTui = sideTui as TUI & {
			openSearch(): void;
			isOverlayFocused(): boolean;
		};
		searchableTui.openSearch();
		assert.equal(searchableTui.isOverlayFocused(), true);

		harness.terminal.send("\u0003");
		harness.terminal.send("x");

		assert.equal(sideCancelCount, 1);
		assert.equal(await running, "closed");
		assert.equal(harness.mainInput.text, "x");
	} finally {
		closeSide?.();
		await running.catch(() => undefined);
		harness.parent.stop();
	}
});

test("default fullscreen enables application-owned mouse selection and restores terminal modes", async () => {
	const writes: string[] = [];
	let outerDone: ((value: unknown) => void) | undefined;
	const terminal = {
		columns: 80,
		rows: 24,
		start() {},
		stop() {},
		write(data: string) {
			writes.push(data);
		},
		hideCursor() {},
		showCursor() {},
	} as never;
	const parent = {
		mode: "regular",
		terminal,
		getShowHardwareCursor: () => false,
		stop() {},
		start() {},
		renderNow() {},
		requestRender() {},
	} as unknown as TUI;
	let editorText = "main draft";
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => FakeComponent) => {
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				factory(
					parent as never,
					{ fg: (_color: string, text: string) => text } as never,
					{} as never,
					((value: unknown) => outerDone?.(value)) as never,
				);
				return result;
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		},
	} as never;

	assert.equal(
		await runBtwFullscreen(ctx, (fullscreenCtx) =>
			fullscreenCtx.ui.custom((_tui, _theme, _keys, done) => immediateComponent(done, [])),
		),
		"side result",
	);
	const output = writes.join("");
	for (const sequence of ["\u001b[?1049h", "\u001b[?1002h", "\u001b[?1006h"]) {
		assert.equal(
			output.includes(sequence),
			true,
			`missing enable sequence ${JSON.stringify(sequence)}`,
		);
	}
	for (const sequence of ["\u001b[?1006l", "\u001b[?1002l", "\u001b[?1049l"]) {
		assert.equal(
			output.includes(sequence),
			true,
			`missing cleanup sequence ${JSON.stringify(sequence)}`,
		);
	}
});

test.each([
	{
		name: "successful host copy",
		copy: async (text: string) => {
			assert.equal(text, "copy me");
		},
		feedback: "Copied!",
	},
	{
		name: "synchronous host failure",
		copy: (_text: string): Promise<void> => {
			throw new Error("clipboard unavailable");
		},
		feedback: "Copy failed",
	},
	{
		name: "rejected host copy",
		copy: async (_text: string) => {
			throw new Error("clipboard rejected");
		},
		feedback: "Copy failed",
	},
])("default fullscreen reports $name and restores its parent", async ({ copy, feedback }) => {
	const { harness, running, sideTui, closeSide } = await startClipboardSelection(copy);
	await flushAsyncWork();
	sideTui.renderNow(true);
	const outputBeforeClose = harness.writes.join("");
	assert.equal(outputBeforeClose.includes("\u001b]52;"), false);
	assert.equal(outputBeforeClose.includes(feedback), true);
	closeSide();

	assert.equal(await running, "closed");
	assert.deepEqual(harness.events, ["parent.stop:true", "parent.start", "parent.renderNow:false"]);
});

test.each(["resolve", "reject"] as const)(
	"a host clipboard promise may %s after close without blocking restoration or rejecting outward",
	async (settlement) => {
		let settleCopy: ((settlement: "resolve" | "reject") => void) | undefined;
		const copy = () =>
			new Promise<void>((resolve, reject) => {
				settleCopy = (result) => {
					if (result === "resolve") resolve();
					else reject(new Error("late clipboard failure"));
				};
			});
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { harness, running, closeSide } = await startClipboardSelection(copy);
			await flushAsyncWork();
			assert.ok(settleCopy);
			closeSide();
			assert.equal(await running, "closed");
			assert.deepEqual(harness.events, [
				"parent.stop:true",
				"parent.start",
				"parent.renderNow:false",
			]);

			settleCopy(settlement);
			await flushAsyncWork();
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	},
);

test("disposal restores the parent while a clipboard copy is pending and contains its late rejection", async () => {
	let rejectCopy: ((error: Error) => void) | undefined;
	const copy = () =>
		new Promise<void>((_resolve, reject) => {
			rejectCopy = reject;
		});
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	try {
		const { harness, running } = await startClipboardSelection(copy);
		await flushAsyncWork();
		assert.ok(rejectCopy);
		assert.ok(harness.outerComponent);
		harness.outerComponent.dispose();
		await assert.rejects(running, /dedicated pi-btw UI was disposed/i);
		assert.deepEqual(harness.events, [
			"parent.stop:true",
			"parent.start",
			"parent.renderNow:false",
		]);

		rejectCopy(new Error("clipboard rejected after disposal"));
		await flushAsyncWork();
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("default fullscreen activates OSC-8 links through the configured URL opener", async () => {
	let handleInput: ((data: string) => void) | undefined;
	const terminal = {
		columns: 80,
		rows: 24,
		start(onInput: (data: string) => void) {
			handleInput = onInput;
		},
		stop() {},
		write() {},
		hideCursor() {},
		showCursor() {},
	} as never;
	const parent = {
		mode: "regular",
		terminal,
		getShowHardwareCursor: () => false,
		stop() {},
		start() {},
		renderNow() {},
		requestRender() {},
	} as unknown as TUI;
	let outerDone: ((value: unknown) => void) | undefined;
	let editorText = "main draft";
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => FakeComponent) => {
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				factory(
					parent as never,
					{ fg: (_color: string, text: string) => text } as never,
					{} as never,
					((value: unknown) => outerDone?.(value)) as never,
				);
				return result;
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		},
	} as never;
	const url = "https://example.com/docs";
	const opened: string[] = [];
	let sideTui: TUI | undefined;
	let closeSide: (() => void) | undefined;
	const running = runBtwFullscreen(
		ctx,
		(fullscreenCtx) =>
			fullscreenCtx.ui.custom<"closed">((tui, _theme, _keys, done) => {
				sideTui = tui;
				closeSide = () => done("closed");
				return {
					render: () => [`\u001b]8;;${url}\u0007documentation\u001b]8;;\u0007`],
					invalidate() {},
					dispose() {},
				};
			}),
		{ openUrl: (target: string) => opened.push(target) },
	);
	await flushAsyncWork();
	assert.ok(sideTui);
	assert.ok(handleInput);
	assert.ok(closeSide);
	sideTui.renderNow(true);
	handleInput("\u001b[<0;1;1M");
	handleInput("\u001b[<0;1;1m");
	const openedBeforeClose = [...opened];
	closeSide();

	assert.equal(await running, "closed");
	assert.deepEqual(openedBeforeClose, [url]);
});

test("dedicated fullscreen owns the terminal while side custom UI runs and restores it afterward", async () => {
	const harness = createHarness();
	const result = await runBtwFullscreen(
		harness.ctx,
		async (ctx) => {
			ctx.ui.notify("side notice", "info");
			assert.equal(ctx.ui.getEditorText(), "main draft");
			ctx.ui.setEditorText("brought side context");
			return ctx.ui.custom<string>((tui, _theme, _keys, done) => {
				assert.equal(tui.mode, "fullscreen");
				return immediateComponent(done, harness.events);
			});
		},
		{ createTui: harness.createTui },
	);

	assert.equal(result, "side result");
	assert.equal(harness.editorText, "brought side context");
	assert.deepEqual(harness.notifications, ["side notice"]);
	assert.deepEqual(harness.events, [
		"parent.stop:true",
		"fullscreen.start",
		"fullscreen.flash:side notice",
		"component.dispose",
		"fullscreen.stop:true",
		"parent.start",
		"parent.renderNow:false",
	]);
});

test("dedicated fullscreen mounts only opt-in components as explicit viewport layouts", async () => {
	const harness = createHarness();
	let closeSide: (() => void) | undefined;
	const layoutRoot: Component = {
		render: () => ["layout root"],
		invalidate() {},
	};
	const running = runBtwFullscreen(
		harness.ctx,
		(ctx) =>
			ctx.ui.custom<"closed">((_tui, _theme, _keys, done) => {
				closeSide = () => done("closed");
				return {
					render: () => ["side"],
					invalidate() {},
					dispose() {},
					getFullscreenLayout: () => layoutRoot,
				};
			}),
		{ createTui: harness.createTui },
	);
	await flushAsyncWork();
	assert.ok(closeSide);
	assert.equal(harness.events.includes("fullscreen.layout"), true);
	assert.equal(harness.events.includes("fullscreen.add"), false);
	closeSide();

	assert.equal(await running, "closed");
	assert.equal(harness.events.includes("fullscreen.layout.clear"), true);
});

test("a layout mount failure clears the root, disposes the component, and restores the parent", async () => {
	const harness = createHarness({ layoutMountError: new Error("layout mount failed") });
	await assert.rejects(
		runBtwFullscreen(
			harness.ctx,
			(ctx) =>
				ctx.ui.custom((_tui, _theme, _keys, _done) => ({
					render: () => ["side"],
					invalidate() {},
					dispose() {
						harness.events.push("component.dispose");
					},
					getFullscreenLayout: () => ({
						render: () => ["layout root"],
						invalidate() {},
					}),
				})),
			{ createTui: harness.createTui },
		),
		/layout mount failed/,
	);

	assert.equal(harness.events.includes("fullscreen.layout.clear"), true);
	assert.equal(harness.events.filter((event) => event === "component.dispose").length, 1);
	assert.equal(harness.events.filter((event) => event === "fullscreen.stop:true").length, 1);
	assert.equal(harness.events.filter((event) => event === "parent.start").length, 1);
});

test("dedicated fullscreen keeps ordinary custom components on the implicit document path", async () => {
	const harness = createHarness();
	let closeSide: (() => void) | undefined;
	const running = runBtwFullscreen(
		harness.ctx,
		(ctx) =>
			ctx.ui.custom<"closed">((_tui, _theme, _keys, done) => {
				closeSide = () => done("closed");
				return {
					render: () => ["side"],
					invalidate() {},
					dispose() {},
				};
			}),
		{ createTui: harness.createTui },
	);
	await flushAsyncWork();
	assert.ok(closeSide);
	assert.equal(harness.events.includes("fullscreen.add"), true);
	assert.equal(harness.events.includes("fullscreen.layout"), false);
	closeSide();

	assert.equal(await running, "closed");
	assert.equal(harness.events.includes("fullscreen.remove"), true);
});

test("dedicated fullscreen restores the parent before propagating a side-flow error", async () => {
	const harness = createHarness();
	await assert.rejects(
		runBtwFullscreen(
			harness.ctx,
			async () => {
				throw new Error("side failed");
			},
			{ createTui: harness.createTui },
		),
		/side failed/,
	);

	assert.deepEqual(harness.events, [
		"parent.stop:true",
		"fullscreen.start",
		"fullscreen.stop:true",
		"parent.start",
		"parent.renderNow:false",
	]);
});

test("a fullscreen stop failure still restarts the parent before it propagates", async () => {
	const harness = createHarness({ fullscreenStopError: new Error("fullscreen stop failed") });
	await assert.rejects(
		runBtwFullscreen(harness.ctx, async () => "done", { createTui: harness.createTui }),
		/fullscreen stop failed/,
	);

	assert.deepEqual(harness.events, [
		"parent.stop:true",
		"fullscreen.start",
		"fullscreen.stop:true",
		"parent.start",
		"parent.renderNow:false",
	]);
});

test("disposing the fullscreen host closes active side UI and restores terminal ownership once", async () => {
	const harness = createHarness();
	let closeSide: (() => void) | undefined;
	const running = runBtwFullscreen(
		harness.ctx,
		(ctx) =>
			ctx.ui.custom<"closed">((_tui, _theme, _keys, done) => {
				closeSide = () => done("closed");
				return {
					render: () => ["waiting"],
					invalidate() {},
					dispose() {
						harness.events.push("component.dispose");
						closeSide?.();
					},
				};
			}),
		{ createTui: harness.createTui },
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(harness.outerComponent);
	harness.outerComponent.dispose();
	harness.outerComponent.dispose();

	assert.equal(await running, "closed");
	assert.equal(harness.events.filter((event) => event === "fullscreen.stop:true").length, 1);
	assert.equal(harness.events.filter((event) => event === "parent.start").length, 1);
	assert.equal(harness.events.filter((event) => event === "component.dispose").length, 1);
});

test("disposal restores the parent and disposes a custom component whose factory settles late", async () => {
	const harness = createHarness();
	let releaseFactory: ((component: FakeComponent) => void) | undefined;
	const running = runBtwFullscreen(
		harness.ctx,
		(ctx) =>
			ctx.ui.custom(
				(_tui, _theme, _keys, _done) =>
					new Promise<FakeComponent>((resolve) => {
						releaseFactory = resolve;
					}),
			),
		{ createTui: harness.createTui },
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(harness.outerComponent);
	harness.outerComponent.dispose();
	await assert.rejects(running, /dedicated pi-btw UI was disposed/i);
	assert.ok(releaseFactory);
	releaseFactory({
		render: () => ["late"],
		invalidate() {},
		dispose() {
			harness.events.push("late-component.dispose");
		},
	});
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(harness.events.filter((event) => event === "fullscreen.stop:true").length, 1);
	assert.equal(harness.events.filter((event) => event === "parent.start").length, 1);
	assert.equal(harness.events.filter((event) => event === "late-component.dispose").length, 1);
});

test("done wins over a later asynchronous custom factory rejection", async () => {
	const harness = createHarness();
	const running = runBtwFullscreen(
		harness.ctx,
		(ctx) =>
			ctx.ui.custom((_tui, _theme, _keys, done) => {
				done("completed result");
				return Promise.reject(new Error("factory failed after done"));
			}),
		{ createTui: harness.createTui },
	);

	await flushAsyncWork();

	assert.equal(await running, "completed result");
	assert.equal(harness.events.filter((event) => event === "fullscreen.stop:true").length, 1);
	assert.equal(harness.events.filter((event) => event === "parent.start").length, 1);
});

test("done restores the parent without waiting for an asynchronous custom factory", async () => {
	const harness = createHarness();
	let releaseFactory: ((component: FakeComponent) => void) | undefined;
	const running = runBtwFullscreen(
		harness.ctx,
		(ctx) =>
			ctx.ui.custom((_tui, _theme, _keys, done) => {
				done("completed result");
				return new Promise<FakeComponent>((resolve) => {
					releaseFactory = resolve;
				});
			}),
		{ createTui: harness.createTui },
	);
	let observed: unknown = "pending";
	void running.then(
		(value) => {
			observed = value;
		},
		(error: unknown) => {
			observed = error;
		},
	);

	await flushAsyncWork();
	assert.ok(releaseFactory);
	const restoredBeforeFactorySettled = harness.events.includes("parent.start");
	releaseFactory({
		render: () => ["late"],
		invalidate() {},
		dispose() {
			harness.events.push("late-after-done.dispose");
		},
	});
	await flushAsyncWork();

	assert.equal(restoredBeforeFactorySettled, true);
	assert.equal(observed, "completed result");
	assert.equal(await running, "completed result");
	assert.equal(harness.events.filter((event) => event === "fullscreen.stop:true").length, 1);
	assert.equal(harness.events.filter((event) => event === "parent.start").length, 1);
	assert.equal(harness.events.filter((event) => event === "late-after-done.dispose").length, 1);
});
