import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { type CompletionDelivery, discoverAgents } from "./agents.js";
import {
	hasOwn,
	inspectCompletionDeliverySettings,
	readSubagentSettings,
	sameToolSet,
	updateAgentToolsSetting,
	updateCompletionDeliverySetting,
	uniqueToolNames,
} from "./settings.js";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "settings", label: "settings", description: "Configure completion delivery" },
	{ value: "status", label: "status", description: "Show effective subagent settings" },
	{ value: "help", label: "help", description: "Show subagent settings help" },
];

export interface SubagentSettingsRuntime {
	getCompletionDelivery(): CompletionDelivery;
	setCompletionDelivery(value: CompletionDelivery): void;
}

export class ToolToggleList {
	private items: { name: string; selected: boolean }[];
	private cursor = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	onDone?: (selected: string[]) => void;
	onCancel?: () => void;

	constructor(tools: string[], selected: Set<string>) {
		this.items = tools.map((name) => ({ name, selected: selected.has(name) }));
	}

	private getSelectedNames(): string[] {
		return this.items.filter((i) => i.selected).map((i) => i.name);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onCancel?.();
			return;
		}
		if (data === "s" || data === "S") {
			this.onDone?.(this.getSelectedNames());
			return;
		}
		if (this.items.length === 0) return;

		if (matchesKey(data, Key.up) && this.cursor > 0) {
			this.cursor--;
			this.invalidate();
		} else if (matchesKey(data, Key.down) && this.cursor < this.items.length - 1) {
			this.cursor++;
			this.invalidate();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.items[this.cursor].selected = !this.items[this.cursor].selected;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.items.map((item, i) => {
			const pointer = i === this.cursor ? ">" : " ";
			const check = item.selected ? "✓" : "○";
			return truncateToWidth(`${pointer} ${check} ${item.name}`, width);
		});
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function registerSubagentConfigCommand(
	pi: ExtensionAPI,
	runtime: SubagentSettingsRuntime,
) {
	registerSubagentPrimaryCommand(pi, runtime);
	pi.registerCommand("subagents:config", {
		description: "Configure which tools each subagent can use",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/subagents:config requires TUI mode", "info");
				return;
			}

			// Get current settings
			const currentSettings = readSubagentSettings() ?? {};
			const currentAgents = currentSettings.agents ?? {};

			// Discover agents to show which ones are available
			const discovery = discoverAgents(ctx.cwd, "user", currentSettings);
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify("No agents found", "warning");
				return;
			}

			// Loop: agent selection → tool toggle (Esc in tools returns here)
			let selectedAgentIndex = 0;
			while (true) {
				// Step 1: pick an agent to configure
				const agentItems: SelectItem[] = agents.map((a) => {
					const cfg = currentAgents[a.name];
					const hasToolsOverride = cfg ? hasOwn(cfg, "tools") : false;
					const toolSummary = hasToolsOverride
						? cfg?.tools && cfg.tools.length > 0
							? cfg.tools.join(", ")
							: "none"
						: "defaults";
					return {
						value: a.name,
						label: a.name,
						description: `${a.source} · tools: ${toolSummary}`,
					};
				});

				const agentName = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(
						new Text(theme.fg("accent", theme.bold("Subagent Tool Configuration")), 1, 0),
					);
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", "Select an agent to configure its allowed tools:"), 1, 0),
					);
					container.addChild(new Spacer(1));
					const selectList = new SelectList(agentItems, Math.min(agentItems.length + 2, 15), {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});
					selectList.setSelectedIndex(selectedAgentIndex);
					selectList.onSelectionChange = (item) => {
						selectedAgentIndex = Math.max(
							0,
							agentItems.findIndex((candidate) => candidate.value === item.value),
						);
					};
					selectList.onSelect = (item) => {
						selectedAgentIndex = Math.max(
							0,
							agentItems.findIndex((candidate) => candidate.value === item.value),
						);
						done(item.value);
					};
					selectList.onCancel = () => done(null);
					container.addChild(selectList);
					container.addChild(
						new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0),
					);
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				});

				if (!agentName) return;

				const agent = agents.find((a) => a.name === agentName);
				if (!agent) return;

				// Step 2: toggle tools for the selected agent
				// Discover without overrides to get original built-in/frontmatter defaults.
				// The main discovery above applies saved overrides, so agent.tools is already
				// overridden — using it for the reset-to-default comparison would match the
				// override against itself and silently delete it on a no-op save.
				const defaultDiscovery = discoverAgents(ctx.cwd, "user");
				const defaultTools = defaultDiscovery.agents.find((a) => a.name === agentName)?.tools;
				const currentAgentSettings = currentAgents[agentName];
				const configuredTools =
					currentAgentSettings && hasOwn(currentAgentSettings, "tools")
						? (currentAgentSettings.tools ?? [])
						: undefined;

				// Get all available tools from pi's registry
				const allTools = uniqueToolNames(pi.getAllTools().map((t) => t.name)).sort((a, b) =>
					a.localeCompare(b),
				);
				const currentTools = uniqueToolNames(configuredTools ?? defaultTools ?? allTools);
				// Sort: currently selected tools first, then rest alphabetically. Preserve
				// unavailable configured tools so saving does not silently drop them.
				const currentSet = new Set(currentTools);
				const selectedFirst = [...currentTools, ...allTools.filter((t) => !currentSet.has(t))];

				const selectedTools = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
					const toggleList = new ToolToggleList(selectedFirst, currentSet);

					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(
						new Text(
							theme.fg("accent", theme.bold(`${agentName} tools`)) +
								theme.fg("muted", ` (${agent.source})`),
							1,
							0,
						),
					);
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							theme.fg("muted", "Toggle tools with Enter/Space. S to save, Esc to cancel."),
							1,
							0,
						),
					);
					container.addChild(new Spacer(1));

					const listContainer = new Container();
					listContainer.addChild({
						render: (w: number) => toggleList.render(w),
						invalidate: () => toggleList.invalidate(),
					});
					container.addChild(listContainer);

					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							theme.fg("dim", "↑↓ navigate · enter/space toggle · S save · esc cancel"),
							1,
							0,
						),
					);
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					toggleList.onDone = (tools) => done(tools);
					toggleList.onCancel = () => done(null);

					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							toggleList.handleInput(data);
							tui.requestRender();
						},
					};
				});

				// null means user cancelled — loop back to agent selection
				if (selectedTools === null) continue;

				// Patch only this agent's tool field so forward-compatible settings survive.
				const restoredDefaults =
					defaultTools === undefined
						? sameToolSet(selectedTools, allTools)
						: sameToolSet(selectedTools, defaultTools);
				updateAgentToolsSetting(agentName, restoredDefaults ? undefined : selectedTools);
				const message = restoredDefaults
					? `${agentName}: defaults restored`
					: `${agentName}: ${selectedTools.length} tool${selectedTools.length !== 1 ? "s" : ""} configured`;
				ctx.ui.notify(message, "info");
				// Saved — exit the loop
				break;
			}
		},
	});
}

function registerSubagentPrimaryCommand(pi: ExtensionAPI, runtime: SubagentSettingsRuntime) {
	pi.registerCommand("subagents", {
		description: "Configure or inspect subagent settings",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const subcommand = args.trim().split(/\s+/u)[0]?.toLowerCase() || "help";
			switch (subcommand) {
				case "settings":
					await showSubagentSettings(ctx, runtime);
					return;
				case "status":
					showSubagentStatus(ctx, runtime);
					return;
				case "help":
					showSubagentHelp(ctx);
					return;
				default:
					if (ctx.mode === "tui" || ctx.hasUI) {
						ctx.ui.notify(`Unknown /subagents subcommand: ${subcommand}`, "warning");
					}
			}
		},
	});
}

async function showSubagentSettings(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const snapshot = inspectCompletionDeliverySettings();
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${snapshot.path}`, "info");
		return;
	}
	if (snapshot.error) {
		ctx.ui.notify(`Subagent settings cannot be edited: ${snapshot.error}`, "error");
		return;
	}
	let currentValue = snapshot.value;
	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		const items: SettingItem[] = [
			{
				id: "completionDelivery",
				label: "Completion delivery",
				description:
					"next-turn queues completion without waking an idle root; auto-resume starts one synthesis turn after the root settles.",
				currentValue,
				values: ["next-turn", "auto-resume"],
			},
		];
		const container = new Container();
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Subagent Settings")), 1, 1),
		);
		let settingsList: SettingsList;
		settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id !== "completionDelivery") return;
				const previous = currentValue;
				const next = newValue as CompletionDelivery;
				try {
					updateCompletionDeliverySetting(next);
					runtime.setCompletionDelivery(next);
					currentValue = next;
					ctx.ui.notify(`Completion delivery set to ${next}.`, "info");
				} catch (error) {
					settingsList.updateValue(id, previous);
					ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
				}
				tui.requestRender();
			},
			() => done(undefined),
		);
		container.addChild(settingsList);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function showSubagentStatus(ctx: ExtensionCommandContext, runtime: SubagentSettingsRuntime) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	const snapshot = inspectCompletionDeliverySettings();
	ctx.ui.notify(
		[
			`pi-subagents source: ${snapshot.source}`,
			`path: ${snapshot.path}`,
			`configured completionDelivery: ${snapshot.value}`,
			`runtime completionDelivery: ${runtime.getCompletionDelivery()}`,
			snapshot.error ? `warning: ${snapshot.error}` : "warning: none",
			"Manual file changes require /reload; /subagents settings applies immediately.",
		].join("\n"),
		snapshot.error ? "warning" : "info",
	);
}

function showSubagentHelp(ctx: ExtensionCommandContext) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	const snapshot = inspectCompletionDeliverySettings();
	ctx.ui.notify(
		[
			"/subagents settings — configure completion delivery",
			"/subagents status — show configured and runtime values",
			"/subagents help — show this help",
			"/subagents:config — configure per-agent tool allow-lists",
			"/subagents:agents list|clear — inspect or clear retained agents",
			`Settings: ${snapshot.path}`,
		].join("\n"),
		"info",
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
