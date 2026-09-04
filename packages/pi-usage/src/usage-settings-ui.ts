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
import type { UsageSettingsRuntime } from "./settings.js";

const OFF = "Off";
const ON = "On";

type UsageSettingId = "codexFastMode" | "codexStatusResetCountdown";

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
	const { HorizontalRule } = await import("@narumitw/pi-tui-kit");
	if (parentSignal.aborted || !isCurrent()) return false;
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
					id: "codexFastMode",
					label: "Codex Fast mode",
					description: "Use faster Codex routing at increased plan allowance consumption.",
					currentValue: state.settings.codexFastMode ? ON : OFF,
					values: [OFF, ON],
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
			const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
			container.addChild(new Text(theme.fg("accent", theme.bold("pi-usage Settings")), 1, 1));

			let settingsList: SettingsList;
			const cancel = () => {
				if (closing) return;
				closing = true;
				localController.abort();
				done(changed);
			};
			const queueUpdate = (id: UsageSettingId, requested: boolean, display: string) => {
				saveQueue = saveQueue.then(async () => {
					const previous = settingsRuntime.get().settings[id];
					if (settingsRuntime.get().kind === "invalid") {
						settingsList.updateValue(id, previous ? ON : OFF);
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
						settingsList.updateValue(id, previous ? ON : OFF);
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
					queueUpdate(id as UsageSettingId, value !== OFF, value);
				},
				cancel,
			);
			container.addChild(settingsList);

			parentSignal.addEventListener("abort", cancel, { once: true });
			return {
				render(width: number) {
					const content = container.render(width);
					const terminalRows = Number.isFinite(tui.terminal?.rows)
						? Math.floor(tui.terminal.rows)
						: 24;
					const availableRows = Math.max(1, terminalRows - 3);
					if (content.length + 2 > availableRows) return content;
					const [ruleLine = ""] = rule.render(width);
					return [ruleLine, ...content, ruleLine];
				},
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
