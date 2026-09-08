import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
	createImplementationOptions,
	type ImplementationOptionAction,
} from "./implementation-options.js";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";
import type { ImplementationPreferences } from "./settings.js";

interface ReadyPlanMenuOptions {
	signal: AbortSignal;
	isCurrent(): boolean;
	implementationPreferences?: ImplementationPreferences;
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	implementHere(
		preferences?: ImplementationPreferences,
		signal?: AbortSignal,
	): void | Promise<void>;
	implementFresh(
		signal: AbortSignal,
		preferences?: ImplementationPreferences,
	): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

interface PlanMenuOptions extends ReadyPlanMenuOptions {
	statusText: string;
	hasReadyPlan: boolean;
	show(): void;
	finalize(): void;
}

export function showPlanModeMenu(ctx: ExtensionContext, options: PlanMenuOptions) {
	return showActions(ctx, options, options);
}

export function showReadyPlanMenu(ctx: ExtensionContext, options: ReadyPlanMenuOptions) {
	return showActions(ctx, options);
}

async function showActions(
	ctx: ExtensionContext,
	options: ReadyPlanMenuOptions,
	current?: PlanMenuOptions,
) {
	const implementation = createImplementationOptions(ctx, options.implementationPreferences);
	const ready = current?.hasReadyPlan ?? true;
	type Screen = "main" | "export" | "implementation-options" | "implementation-model";
	type Action =
		| ImplementationOptionAction
		| "show"
		| "finalize"
		| "implement-here"
		| "implement-fresh"
		| "export"
		| "save"
		| "stay"
		| "exit";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "main",
		screens: {
			...implementation.screens,
			main: () => ({
				kind: "actions",
				title: current ? "Plan mode" : "Proposed plan ready. What next?",
				lines: [
					...(current ? [current.statusText] : []),
					...(ready
						? [
								"Implement here keeps this planning conversation.",
								"Start fresh transfers only the approved plan to a new session.",
								options.implementationOutcome(),
								implementation.summary(),
							]
						: []),
				],
				items: ready
					? [
							...(current
								? [{ id: "show", label: "Show latest proposed plan", action: "show" as const }]
								: []),
							{
								id: "implement-here",
								label: "Implement here",
								description: "Continue in this session with the planning conversation.",
								action: "implement-here",
								busyLabel: "Preparing implementation…",
							},
							{
								id: "implement-fresh",
								label: "Start fresh and implement",
								description: "Open a new linked session; transfer only the approved plan.",
								action: "implement-fresh",
								busyLabel: "Starting fresh implementation session…",
							},
							{
								id: "implementation-options",
								label: "Implementation options…",
								to: "implementation-options",
							},
							{ id: "export", label: "Export plan…", to: "export" },
							{ id: "save", label: "Save for later", action: "save" },
							{ id: "stay", label: "Stay in Plan mode", action: "stay" },
							{ id: "exit", label: "Discard plan and exit", action: "exit" },
						]
					: [
							{ id: "finalize", label: "Request final plan", action: "finalize" },
							{ id: "stay", label: "Stay in Plan mode", action: "stay" },
							{ id: "exit", label: "Exit Plan mode", action: "exit" },
						],
				hint: "close",
			}),
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
			...implementation.actions,
			show: async () => {
				current?.show();
				return { kind: "close" };
			},
			finalize: async () => {
				current?.finalize();
				return { kind: "close" };
			},
			"implement-here": async ({ signal }) => {
				await options.implementHere(implementation.get(), signal);
				return { kind: "close" };
			},
			"implement-fresh": async ({ signal }) => {
				await options.implementFresh(signal, implementation.get());
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			save: async () => {
				options.save();
				return { kind: "close" };
			},
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
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
