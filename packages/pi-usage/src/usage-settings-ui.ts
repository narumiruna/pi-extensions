import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionCommandContext,
  getSelectListTheme,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  Loader,
  matchesKey,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import { errorMessage } from "./core.js";
import { kimiUsageCredentialLabel, normalizeKimiUsageApiKey } from "./kimi-usage-credential.js";
import type { UsageSettings, UsageSettingsRuntime } from "./settings.js";

const OFF = "Off";
const ON = "On";
const REMAINING = "Remaining";
const USED = "Used";

type ToggleSettingId =
  | "codexFastMode"
  | "codexStatusResetCountdown"
  | "codexStatusPercentage"
  | "openaiUseCodexUsage"
  | "anthropicExtraUsage";

type UsageSettingId = ToggleSettingId | "kimiCodingUsageApiKey";
type CredentialAction = "set-kimi" | "clear-kimi";

function settingValueLabel(id: ToggleSettingId, value: UsageSettings[ToggleSettingId]): string {
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
  let selectedSetting: string | undefined;
  while (!parentSignal.aborted && isCurrent()) {
    const result = await runCustomInteraction<CredentialAction | undefined>(ctx, {
      signal: parentSignal,
      isCurrent,
      onError: () => {},
      create({ tui, theme, signal, complete }) {
        let closing = false;
        let transitioning = false;
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
          {
            id: "anthropicExtraUsage",
            label: "Claude extra usage",
            description:
              "Experimental: read Claude extra-usage spending and the monthly limit with the matched Anthropic OAuth login. Sends the access token to an undocumented Anthropic usage endpoint; no billing settings are changed.",
            currentValue: state.settings.anthropicExtraUsage ? ON : OFF,
            values: [OFF, ON],
          },
          {
            id: "kimiCodingUsageApiKey",
            label: "Kimi proxy usage key",
            description:
              "Use a separate official Kimi credential for proxy-selected Kimi usage only. Saved in user pi-usage.json; a nonblank PI_USAGE_KIMI_CODING_API_KEY overrides the saved key. Inference is unchanged.",
            currentValue: kimiUsageCredentialLabel(state.settings.kimiCodingUsageApiKey),
            submenu: (_value, done) => {
              const actions = new SelectList(
                [
                  {
                    value: "set-kimi",
                    label: "Set / update key",
                    description: "Enter a hidden official Kimi credential.",
                  },
                  ...(settingsRuntime.get().settings.kimiCodingUsageApiKey
                    ? [
                        {
                          value: "clear-kimi",
                          label: "Clear saved key",
                          description: "An environment override remains active.",
                        },
                      ]
                    : []),
                  { value: "back", label: "Back" },
                ],
                3,
                getSelectListTheme(),
              );
              actions.onCancel = () => done();
              actions.onSelect = ({ value }) => {
                if (value === "back") {
                  done();
                  return;
                }
                if (closing || transitioning || signal.aborted || !isCurrent()) return;
                if (value !== "set-kimi" && value !== "clear-kimi") return;
                transitioning = true;
                // A secret-dialog handoff is not cancellation of earlier setting changes.
                saveQueue = saveQueue.then(() => {
                  if (signal.aborted || !isCurrent()) return;
                  closing = true;
                  complete(value);
                });
              };
              return actions;
            },
          },
        ];
        const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });

        let settingsList: SettingsList;
        const cancel = () => {
          if (closing) return;
          closing = true;
          complete(undefined);
        };
        const queueUpdate = <Id extends ToggleSettingId>(id: Id, requested: UsageSettings[Id], display: string) => {
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
            if (closing || transitioning || signal.aborted || !isCurrent()) return;
            if (id === "codexStatusPercentage") {
              queueUpdate(id, value === USED ? "used" : "remaining", value);
            } else if (
              id === "codexFastMode" ||
              id === "codexStatusResetCountdown" ||
              id === "openaiUseCodexUsage" ||
              id === "anthropicExtraUsage"
            ) {
              queueUpdate(id, value === ON, value);
            }
          },
          cancel,
        );
        if (selectedSetting) settingsList.selectItem(selectedSetting);

        return {
          get capturesViewportInput() {
            return settingsList.capturesViewportInput;
          },
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
    if (result.kind !== "completed" || !result.value || parentSignal.aborted || !isCurrent()) break;
    selectedSetting = "kimiCodingUsageApiKey";
    if (settingsRuntime.get().kind === "invalid") {
      ctx.ui.notify("Repair pi-usage.json and reload before changing settings.", "error");
      continue;
    }
    let requested: string | undefined;
    if (result.value === "set-kimi") {
      const entered = await promptKimiUsageKey(ctx, parentSignal, isCurrent);
      if (parentSignal.aborted || !isCurrent()) break;
      if (entered.kind === "closed" && entered.reason === "back") continue;
      if (entered.kind !== "submitted") break;
      requested = normalizeKimiUsageApiKey(entered.value);
      if (!requested) {
        ctx.ui.notify("Enter a nonblank printable ASCII credential without whitespace.", "error");
        continue;
      }
    }
    if (parentSignal.aborted || !isCurrent()) break;
    const previous = settingsRuntime.get().settings.kimiCodingUsageApiKey;
    // Pi can dispose a custom dialog without resolving custom(). Retain the disk task
    // through runCustomInteraction's disposal boundary rather than a runner that waits
    // only for the host's done callback.
    const saved = await runCustomInteraction<"saved" | "failed" | undefined>(ctx, {
      signal: parentSignal,
      isCurrent,
      onError: () => {},
      create({ tui, theme, keybindings, signal, complete }) {
        const loader = new Loader(
          tui,
          (text) => theme.fg("accent", text),
          (text) => theme.fg("muted", text),
          "Saving Kimi usage credential…",
        );
        const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
        let disposed = false;
        const pending = (async () => {
          try {
            await settingsRuntime.update({ kimiCodingUsageApiKey: requested }, signal);
            // A completed rename still owns cleanup when the save UI was canceled.
            if (previous !== requested) {
              changed = true;
              onApplied("kimiCodingUsageApiKey", signal.aborted);
            }
            if (!signal.aborted && isCurrent()) complete("saved");
          } catch {
            if (!signal.aborted && isCurrent()) complete("failed");
          }
        })();
        return {
          render(width) {
            const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
            if (columns === 0) return [];
            const rows = Number.isFinite(tui.terminal?.rows) ? Math.floor(tui.terminal.rows) : 24;
            // Pi's fullscreen viewport can consume configured cancel keys first.
            // Advertise only hard cancel, and restyle the hint at every render.
            const hint = theme.fg("dim", "Ctrl+C cancel");
            return renderBoundedFrame({
              width: columns,
              maxRows: Math.max(1, rows - 3),
              rule: rule.render(columns)[0] ?? "",
              title: [],
              content: loader.render(columns),
              hints: new Text(hint, 1, 0).render(columns),
              compactHint: hint,
              priorityRows: [0],
            });
          },
          invalidate() {
            loader.invalidate();
            rule.invalidate();
          },
          handleInput(data) {
            if (disposed || signal.aborted) return;
            if (!isCurrent() || matchesKey(data, Key.ctrl("c")) || keybindings.matches(data, "tui.select.cancel")) {
              complete(undefined);
            }
          },
          waitForPending: () => pending,
          dispose() {
            if (disposed) return;
            disposed = true;
            loader.stop();
          },
        };
      },
    });
    if (parentSignal.aborted || !isCurrent() || saved.kind === "stale") break;
    if (saved.kind === "completed" && saved.value === undefined) break;
    if (saved.kind === "error" || (saved.kind === "completed" && saved.value === "failed")) {
      // Storage exceptions can contain the submitted payload; never show their raw text.
      ctx.ui.notify(
        "Could not save the Kimi usage credential. Repair pi-usage.json or check file permissions and retry.",
        "error",
      );
    }
  }
  return changed;
}

async function promptKimiUsageKey(ctx: ExtensionCommandContext, signal: AbortSignal, isCurrent: () => boolean) {
  const { runSecretInput } = await import("@narumitw/pi-tui-kit");
  const cancel = new AbortController();
  const ownedSignal = AbortSignal.any([signal, cancel.signal]);
  // Keep Ctrl+C a hard cancel even inside an unfinished bracketed paste. Kit owns
  // masked rendering and all ordinary editing, paste, focus, and disposal behavior.
  const custom: typeof ctx.ui.custom = (factory, options) =>
    ctx.ui.custom(async (...args) => {
      const component = await factory(...args);
      let disposed = false;
      const handleInput = component.handleInput?.bind(component);
      const dispose = component.dispose?.bind(component);
      component.handleInput = (data: string) => {
        if (disposed || ownedSignal.aborted) return;
        if (!isKeyRelease(data) && matchesKey(data, Key.ctrl("c"))) cancel.abort();
        else handleInput?.(data);
      };
      component.dispose = () => {
        disposed = true;
        dispose?.();
      };
      return component;
    }, options);
  try {
    return await runSecretInput(
      { ...ctx, ui: { ...ctx.ui, custom } },
      { title: "Official Kimi usage key", signal: ownedSignal, isCurrent, onError: () => {} },
    );
  } finally {
    cancel.abort();
  }
}
