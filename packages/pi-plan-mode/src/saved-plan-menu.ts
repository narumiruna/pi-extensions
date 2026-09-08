import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface SavedPlanMenuOptions {
	statusText: string;
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	signal: AbortSignal;
	isCurrent(): boolean;
	show(): void;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	settings(signal: AbortSignal): Promise<boolean>;
	clear(): void;
}

export async function showSavedPlanMenu(ctx: ExtensionContext, options: SavedPlanMenuOptions) {
	if (!ctx.hasUI) {
		throw new Error(
			`${options.statusText} Use /plan show, /plan implement, /plan export, or /plan exit.`,
		);
	}
	type Screen = "saved" | "export";
	type Action = "show" | "implement-here" | "implement-fresh" | "export" | "settings" | "clear";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "saved",
		screens: {
			saved: () => ({
				kind: "actions",
				title: "Saved plan",
				lines: [
					options.statusText,
					"Implement here keeps this planning conversation.",
					"Start fresh transfers only the approved plan to a new session.",
					options.implementationOutcome(),
				],
				items: [
					{ id: "show", label: "Show saved plan", action: "show" },
					{
						id: "implement-here",
						label: "Implement here",
						description: "Continue in this session with the planning conversation.",
						action: "implement-here",
					},
					{
						id: "implement-fresh",
						label: "Start fresh and implement",
						description: "Open a new linked session; transfer only the approved plan.",
						action: "implement-fresh",
						busyLabel: "Starting fresh implementation session…",
					},
					{ id: "export", label: "Export plan…", to: "export" },
					{ id: "settings", label: "Settings", action: "settings" },
					{ id: "clear", label: "Clear saved plan", action: "clear" },
				],
				hint: "close",
			}),
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
			show: async () => {
				options.show();
				return { kind: "close" };
			},
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"implement-fresh": async ({ signal }) => {
				await options.implementFresh(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			settings: async ({ signal }) => {
				const close = await options.settings(signal);
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				return close ? { kind: "close" } : { kind: "stay" };
			},
			clear: async () => {
				options.clear();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}
