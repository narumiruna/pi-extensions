import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { errorMessage } from "./core.js";
import type { UsageSettings, UsageSettingsRuntime } from "./settings.js";

const OFF = "Off";
const ON = "On";
const REMAINING = "Remaining";
const USED = "Used";

type UsageSettingId = "codexFastMode" | "codexStatusResetCountdown" | "codexStatusPercentage" | "openaiUseCodexUsage";

function settingValueLabel(id: UsageSettingId, value: UsageSettings[UsageSettingId]): string {
  if (id === "codexStatusPercentage") return value === "used" ? USED : REMAINING;
  return value === true ? ON : OFF;
}

export async function showUsageSettings(
  ctx: ExtensionCommandContext,
  settingsRuntime: UsageSettingsRuntime,
  parentSignal: AbortSignal,
  isCurrent: () => boolean,
  onApplied: (id: UsageSettingId, uiClosed: boolean) => void,
): Promise<boolean> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${settingsRuntime.get().path}`, "info");
    return false;
  }
  const { HorizontalRule, renderBoundedFrame, runCustomInteraction } = await import("@narumitw/pi-tui-kit");
  if (parentSignal.aborted || !isCurrent()) return false;
  let changed = false;
  const result = await runCustomInteraction<void>(ctx, {
    signal: parentSignal,
    isCurrent,
    onError: () => {},
    create({ tui, theme, signal, complete }) {
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
        {
          id: "codexStatusPercentage",
          label: "Codex percentage",
          description: "Show remaining or used Codex quota in the statusline.",
          currentValue: settingValueLabel("codexStatusPercentage", state.settings.codexStatusPercentage),
          values: [REMAINING, USED],
        },
        {
          id: "openaiUseCodexUsage",
          label: "Use Codex login for OpenAI usage",
          description:
            "Read native OpenAI usage with the Codex login. Enable only when both logins use the same ChatGPT account and workspace. Experimental: sends the Codex bearer and account ID to undocumented ChatGPT endpoints; shared identity is not verified.",
          currentValue: state.settings.openaiUseCodexUsage ? ON : OFF,
          values: [OFF, ON],
        },
      ];
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });

      let settingsList: SettingsList;
      const cancel = () => {
        if (closing) return;
        closing = true;
        complete();
      };
      const queueUpdate = <Id extends UsageSettingId>(id: Id, requested: UsageSettings[Id], display: string) => {
        saveQueue = saveQueue.then(async () => {
          if (signal.aborted || !isCurrent()) return;
          const previous = settingsRuntime.get().settings[id];
          if (settingsRuntime.get().kind === "invalid") {
            settingsList.updateValue(id, settingValueLabel(id, previous));
            if (!signal.aborted && isCurrent()) {
              ctx.ui.notify("Repair pi-usage.json and reload before changing settings.", "error");
              tui.requestRender();
            }
            return;
          }
          try {
            const patch: Partial<UsageSettings> = {};
            patch[id] = requested;
            await settingsRuntime.update(patch, signal);
          } catch (error) {
            if (signal.aborted || !isCurrent()) return;
            settingsList.updateValue(id, settingValueLabel(id, previous));
            ctx.ui.notify(`Could not save pi-usage.json: ${errorMessage(error)}`, "error");
            tui.requestRender();
            return;
          }
          // A rename can win a cancellation race. Apply owned lifecycle cleanup after a
          // durable save, but let the owner guard its session before touching UI.
          if (previous !== requested) {
            changed = true;
            onApplied(id, signal.aborted);
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
          if (id === "codexStatusPercentage") {
            queueUpdate(id, value === USED ? "used" : "remaining", value);
          } else if (id === "codexFastMode" || id === "codexStatusResetCountdown" || id === "openaiUseCodexUsage") {
            queueUpdate(id, value === ON, value);
          }
        },
        cancel,
      );

      return {
        render(width: number) {
          // Compatibility: Kit puts the title directly below the top rule and keeps compact
          // rules when at least five rows fit; both replace the legacy wrapper layout.
          const title = new Text(theme.fg("accent", theme.bold("pi-usage Settings")), 1, 0).render(width);
          const content = settingsList.render(width);
          const focusedRow = content.findIndex((line) => /^[→›]\s/u.test(stripVTControlCharacters(line)));
          const terminalRows = Number.isFinite(tui.terminal?.rows) ? Math.floor(tui.terminal.rows) : 24;
          const [ruleLine = ""] = rule.render(width);
          return renderBoundedFrame({
            width,
            maxRows: Math.max(1, terminalRows - 3),
            rule: ruleLine,
            title,
            content,
            priorityRows: focusedRow < 0 ? [] : [focusedRow],
            focusedRow,
          });
        },
        invalidate: () => settingsList.invalidate(),
        handleInput(data: string) {
          if (closing || signal.aborted) return;
          if (!isCurrent() || matchesKey(data, Key.ctrl("c"))) cancel();
          else settingsList.handleInput(data);
          if (!signal.aborted && isCurrent()) tui.requestRender();
        },
        waitForPending: () => saveQueue,
        dispose() {
          closing = true;
        },
      };
    },
  });
  if (result.kind === "error") throw result.error;
  return changed;
}
