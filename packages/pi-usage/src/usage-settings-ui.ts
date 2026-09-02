import {
	type ExtensionCommandContext,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import { errorMessage } from "./core.js";
import type { OpenAIServiceTier, UsageSettings, UsageSettingsRuntime } from "./settings.js";

const DEFAULT = "Default";
const FLEX = "Flex";
const OFF = "Off";
const ON = "On";
const PRIORITY = "Priority";

type UsageSettingId = "openaiServiceTier" | "codexStatusResetCountdown";

export async function showUsageSettings(
	ctx: ExtensionCommandContext,
	settingsRuntime: UsageSettingsRuntime,
	parentSignal: AbortSignal,
	isCurrent: () => boolean,
	onApplied: (id: UsageSettingId) => void,
): Promise<boolean> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${settingsRuntime.get().path}`, "info");
		return false;
	}
	return (
		(await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
			const localController = new AbortController();
			const signal = AbortSignal.any([parentSignal, localController.signal]);
			let changed = false;
			let closing = false;
			let saveQueue = Promise.resolve();
			const state = settingsRuntime.get();
			const items: SettingItem[] = [
				{
					id: "openaiServiceTier",
					label: "OpenAI service tier",
					description: "Choose standard, faster Priority, or lower-cost Flex processing.",
					currentValue: displayServiceTier(state.settings.openaiServiceTier),
					values: [DEFAULT, PRIORITY, FLEX],
				},
				{
					id: "codexStatusResetCountdown",
					label: "Codex reset countdown",
					description: "Show time remaining until each Codex usage limit resets.",
					currentValue: state.settings.codexStatusResetCountdown ? ON : OFF,
					values: [OFF, ON],
				},
			];
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("pi-usage Settings")), 1, 1));

			let settingsList: SettingsList;
			const cancel = () => {
				if (closing) return;
				closing = true;
				localController.abort();
				done(changed);
			};
			const queueUpdate = (
				id: UsageSettingId,
				requested: UsageSettings[UsageSettingId],
				display: string,
			) => {
				saveQueue = saveQueue.then(async () => {
					const previous = settingsRuntime.get().settings[id];
					if (settingsRuntime.get().kind === "invalid") {
						settingsList.updateValue(id, displaySetting(id, previous));
						if (!signal.aborted && isCurrent()) {
							ctx.ui.notify("Repair pi-usage.json and reload before changing settings.", "error");
							tui.requestRender();
						}
						return;
					}
					try {
						await settingsRuntime.update({ [id]: requested }, signal);
					} catch (error) {
						if (signal.aborted || !isCurrent()) return;
						settingsList.updateValue(id, displaySetting(id, previous));
						ctx.ui.notify(`Could not save pi-usage.json: ${errorMessage(error)}`, "error");
						tui.requestRender();
						return;
					}
					if (previous !== requested) {
						changed = true;
						onApplied(id);
					}
					if (signal.aborted || !isCurrent()) return;
					settingsList.updateValue(id, display);
					tui.requestRender();
				});
			};
			settingsList = new SettingsList(
				items,
				items.length + 2,
				getSettingsListTheme(),
				(id, value) => {
					if (closing || signal.aborted || !isCurrent()) return;
					if (id === "openaiServiceTier") {
						const requested = parseServiceTier(value);
						if (requested) queueUpdate(id, requested, value);
						return;
					}
					queueUpdate(id as "codexStatusResetCountdown", value !== OFF, value);
				},
				cancel,
			);
			container.addChild(settingsList);

			parentSignal.addEventListener("abort", cancel, { once: true });
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput(data: string) {
					if (closing) return;
					if (matchesKey(data, Key.ctrl("c"))) cancel();
					else settingsList.handleInput(data);
					tui.requestRender();
				},
				dispose() {
					localController.abort();
					parentSignal.removeEventListener("abort", cancel);
				},
			};
		})) ?? false
	);
}

function displaySetting(id: UsageSettingId, value: UsageSettings[UsageSettingId]): string {
	if (id === "openaiServiceTier") return displayServiceTier(value);
	return value ? ON : OFF;
}

function displayServiceTier(value: unknown): string {
	if (value === "priority") return PRIORITY;
	if (value === "flex") return FLEX;
	return DEFAULT;
}

function parseServiceTier(value: string): OpenAIServiceTier | undefined {
	if (value === PRIORITY) return "priority";
	if (value === FLEX) return "flex";
	if (value === DEFAULT) return "default";
	return undefined;
}
