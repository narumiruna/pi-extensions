import type { MenuDefinition } from "@narumitw/pi-tui-kit";

export function createHerdrMenu(options: {
	settingsPath: string;
	isEnabled(): boolean;
	toggle(signal: AbortSignal): Promise<boolean>;
}): MenuDefinition<undefined, "main" | "status" | "help", "toggle"> {
	return {
		start: "main",
		screens: {
			// One setting stays on the main menu, matching /tool rather than adding a submenu.
			main: () => ({
				kind: "actions",
				title: "Herdr",
				items: [
					{
						id: "widget",
						label: `Agent widget: ${options.isEnabled() ? "On" : "Off"}`,
						description: "Show or hide sibling agents above the editor",
						action: "toggle",
					},
					{ id: "status", label: "Status", to: "status" },
					{ id: "help", label: "Help", to: "help" },
					{ id: "close", label: "Close", close: true },
				],
				hint: "close",
			}),
			status: () => ({
				kind: "detail",
				title: "Herdr Status",
				lines: [
					`Agent widget setting: ${options.isEnabled() ? "on" : "off"}`,
					"The widget appears only in TUI mode with recognized sibling agents.",
					"Lifecycle and metadata reporting are independent of this setting.",
					`User settings file: ${options.settingsPath}`,
				],
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "Herdr Help",
				lines: [
					"Toggle Agent widget from /herdr. Changes are saved immediately; closing does not undo them.",
					"Manual pi-herdr.json changes apply after /reload or the next session start.",
					"The widget defaults to on. Project overrides are not read.",
				],
				hint: "back",
			}),
		},
		actions: {
			toggle: async ({ signal }) =>
				(await options.toggle(signal)) ? { kind: "stay" } : { kind: "rejected" },
		},
	};
}
