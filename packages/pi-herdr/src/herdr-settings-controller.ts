import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HerdrWidgetObserver } from "./herdr-observer.js";
import {
	awaitHerdrSettingsWrites,
	herdrSettingsPath,
	readHerdrSettings,
	updateHerdrSettings,
} from "./settings.js";

export interface HerdrSettingsOptions {
	settingsPath?: string;
}

export function createHerdrSettingsController(
	pi: ExtensionAPI,
	observer: HerdrWidgetObserver,
	options: HerdrSettingsOptions = {},
) {
	const settingsPath = options.settingsPath ?? herdrSettingsPath();
	let generation = 0;
	let owner: ExtensionContext | undefined;
	let controller = new AbortController();
	let enabled = true;
	let changes = Promise.resolve();
	let menuOpen = false;
	const current = (expected: number) => expected === generation && !controller.signal.aborted;

	pi.registerCommand("herdr", {
		description: "Configure the Herdr agent widget",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("/herdr does not accept arguments.");
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				throw new Error("/herdr requires TUI or RPC mode.");
			}
			if (!owner || ctx.sessionManager !== owner.sessionManager || menuOpen) return;
			const expected = generation;
			const signal = controller.signal;
			menuOpen = true;
			try {
				const [{ runMenu }, { createHerdrMenu }] = await Promise.all([
					import("@narumitw/pi-tui-kit"),
					import("./herdr-menu.js"),
				]);
				if (!current(expected)) return;
				await runMenu(
					ctx,
					createHerdrMenu({
						settingsPath,
						isEnabled: () => enabled,
						toggle: (actionSignal) => {
							const result = changes.then(async () => {
								if (actionSignal.aborted || !current(expected) || !owner) return false;
								// Once accepted, finish the explicit save even if the menu closes.
								// Session replacement still prevents stale runtime publication.
								const previous = enabled;
								const actionOwner = owner;
								try {
									enabled = !previous;
									if (enabled && actionOwner.mode === "tui") observer.start(actionOwner);
									else await observer.shutdown(actionOwner);
									if (!current(expected)) return false;
									await updateHerdrSettings({ widget: enabled }, { settingsPath });
									return current(expected);
								} catch {
									if (!current(expected)) return false;
									enabled = previous;
									try {
										if (previous && actionOwner.mode === "tui") observer.start(actionOwner);
										else await observer.shutdown(actionOwner);
									} finally {
										if (current(expected))
											ctx.ui.notify(
												"Herdr settings were not saved; the previous widget setting was restored. Check pi-herdr.json and its permissions.",
												"warning",
											);
									}
									return false;
								}
							});
							changes = result.then(
								() => undefined,
								() => undefined,
							);
							return result;
						},
					}),
					{
						getState: () => undefined,
						signal,
						isCurrent: () => current(expected),
						onError: () => {
							if (current(expected))
								ctx.ui.notify("The Herdr menu could not be displayed.", "error");
						},
					},
				);
			} finally {
				if (expected === generation) menuOpen = false;
			}
		},
	});

	return {
		async start(ctx: ExtensionContext) {
			const expected = ++generation;
			controller.abort();
			controller = new AbortController();
			menuOpen = false;
			const previous = owner;
			owner = ctx;
			if (previous) await observer.shutdown(previous);
			if (!current(expected)) return;
			await changes;
			if (!current(expected)) return;
			const loaded = await readHerdrSettings(settingsPath);
			if (!current(expected)) return;
			enabled = loaded.settings.widget;
			if (loaded.kind === "invalid" && ctx.hasUI)
				ctx.ui.notify(
					"Herdr ignored invalid pi-herdr.json settings and kept the widget enabled. Fix the file before saving.",
					"warning",
				);
			if (enabled && ctx.mode === "tui") observer.start(ctx);
		},
		async shutdown(ctx: ExtensionContext) {
			if (ctx.sessionManager !== owner?.sessionManager) return;
			generation += 1;
			controller.abort();
			owner = undefined;
			menuOpen = false;
			await Promise.all([observer.shutdown(ctx), changes]);
			await awaitHerdrSettingsWrites(settingsPath);
		},
	};
}
