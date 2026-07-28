import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "../src/index.js";

type Screen = "main" | "settings";
type Action = "refresh" | "setMode";
interface State {
	mode: "Safe" | "Fast";
}

declare function refreshDomainState(signal: AbortSignal): Promise<void>;
declare function saveMode(mode: State["mode"], signal: AbortSignal): Promise<void>;
declare function loadState(signal: AbortSignal): Promise<State>;
declare function currentGeneration(): number;
declare function currentSessionSignal(): AbortSignal;
declare function formatError(error: unknown): string;

const menu = defineMenu<State, Screen, Action>({
	start: "main",
	screens: {
		main: ({ state }) => ({
			kind: "actions",
			title: "Example extension",
			lines: [`Current mode: ${state.mode}`],
			items: [
				{ id: "refresh", label: "Refresh", action: "refresh", busyLabel: "Refreshing" },
				{ id: "settings", label: "Settings", to: "settings" },
				{ id: "close", label: "Close", close: true },
			],
			hint: "close",
		}),
		settings: ({ state }) => ({
			kind: "settings",
			title: "Settings",
			items: [
				{
					id: "mode",
					label: "Mode",
					currentValue: state.mode,
					values: ["Safe", "Fast"],
					action: "setMode",
				},
			],
		}),
	},
	actions: {
		refresh: async ({ signal }) => {
			await refreshDomainState(signal);
			return { kind: "stay" };
		},
		setMode: async ({ value, signal }) => {
			await saveMode(value === "Fast" ? "Fast" : "Safe", signal);
			return { kind: "stay" };
		},
	},
});

export async function showMenu(ctx: ExtensionCommandContext, generation: number) {
	return runMenu(ctx, menu, {
		getState: ({ signal }) => loadState(signal),
		signal: currentSessionSignal(),
		isCurrent: () => generation === currentGeneration(),
		onError: (_ctx, error) => ctx.ui.notify(formatError(error), "error"),
		onUnsupportedMode: (_ctx, mode) => {
			ctx.ui.notify(`The menu is unavailable in ${mode} mode.`, "warning");
		},
	});
}
