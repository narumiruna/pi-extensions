import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { discoverAgents, type SubagentSettings } from "./agents.js";
import {
	hasAnyAgentOverride,
	hasOwn,
	readSubagentSettings,
	sameToolSet,
	saveSubagentConfig,
	uniqueToolNames,
} from "./settings.js";

class ToolToggleList {
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

export function registerSubagentConfigCommand(pi: ExtensionAPI) {
	pi.registerCommand("subagents:config", {
		description: "Configure which tools each subagent can use",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
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
					selectList.onSelect = (item) => done(item.value);
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
						new Text(theme.fg("muted", "Toggle tools with Enter/Space. S to save, Esc to cancel."), 1, 0),
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
						new Text(theme.fg("dim", "↑↓ navigate · enter/space toggle · S save · esc cancel"), 1, 0),
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

				// Save to global settings
				const updatedAgents = { ...currentAgents };
				let restoredDefaults = false;

				const isSameAsDefault =
					defaultTools === undefined
						? sameToolSet(selectedTools, allTools)
						: sameToolSet(selectedTools, defaultTools);

				if (isSameAsDefault) {
					// Tools match defaults — remove only the tools override.
					// Keep other settings (model, timeoutMs) if present.
					const existing = updatedAgents[agentName];
					if (existing) {
						const nextConfig = { ...existing };
						delete nextConfig.tools;
						if (hasAnyAgentOverride(nextConfig)) updatedAgents[agentName] = nextConfig;
						else delete updatedAgents[agentName];
					}
					restoredDefaults = true;
				} else {
					updatedAgents[agentName] = {
						...updatedAgents[agentName],
						tools: selectedTools,
					};
				}

				const newSettings: SubagentSettings = {
					...currentSettings,
					agents: Object.keys(updatedAgents).length > 0 ? updatedAgents : undefined,
				};

				saveSubagentConfig(newSettings);
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
