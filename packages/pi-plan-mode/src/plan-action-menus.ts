import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface MenuLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
}

const IMPLEMENTATION_CONTEXT_LINES = [
	"Implement here keeps this planning conversation.",
	"Start fresh transfers only the approved plan to a new session.",
] as const;

interface PlanMenuOptions extends MenuLifecycle {
	statusText: string;
	hasReadyPlan: boolean;
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	show(): void;
	finalize(): void;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

export async function showPlanModeMenu(ctx: ExtensionContext, options: PlanMenuOptions) {
	type Screen = "main" | "export";
	type Action =
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
			main: () => ({
				kind: "actions",
				title: "Plan mode",
				lines: [
					options.statusText,
					...(options.hasReadyPlan
						? [...IMPLEMENTATION_CONTEXT_LINES, options.implementationOutcome()]
						: []),
				],
				items: options.hasReadyPlan
					? [
							{ id: "show", label: "Show latest proposed plan", action: "show" },
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
			show: async () => {
				options.show();
				return { kind: "close" };
			},
			finalize: async () => {
				options.finalize();
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

interface ReadyPlanMenuOptions extends MenuLifecycle {
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

export async function showReadyPlanMenu(ctx: ExtensionContext, options: ReadyPlanMenuOptions) {
	type Screen = "ready" | "export";
	type Action = "implement-here" | "implement-fresh" | "export" | "save" | "stay" | "exit";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "ready",
		screens: {
			ready: () => ({
				kind: "actions",
				title: "Proposed plan ready. What next?",
				lines: [...IMPLEMENTATION_CONTEXT_LINES, options.implementationOutcome()],
				items: [
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
					{ id: "save", label: "Save for later", action: "save" },
					{ id: "stay", label: "Stay in Plan mode", action: "stay" },
					{ id: "exit", label: "Discard plan and exit", action: "exit" },
				],
				hint: "close",
			}),
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
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
