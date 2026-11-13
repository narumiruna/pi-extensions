import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { availableFirecrawlTools, firecrawlToolMode } from "./lazy-tools.js";
import {
  DEFAULT_TOOL_MODE,
  FIRECRAWL_TOOL_MODES,
  isFirecrawlToolMode,
  loadSettings,
  settingsFilePath,
} from "./settings.js";
import { settingsKeyHints } from "./settings-key-hints.js";
import { FIRECRAWL_TOOL_NAMES, type FirecrawlToolName } from "./tool-names.js";
import {
  currentFirecrawlSessionGeneration,
  currentFirecrawlSessionSignal,
  isCurrentFirecrawlSession,
  sanitizeFirecrawlDisplay,
  setFirecrawlCapabilityEnabled,
  setFirecrawlToolMode,
  waitForFirecrawlSettings,
} from "./tool-selector.js";

export async function showFirecrawlSettings(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    if (ctx.mode === "rpc" && ctx.hasUI) {
      ctx.ui.notify(
        sanitizeFirecrawlDisplay(
          `Edit Firecrawl settings: ${settingsFilePath()}\nSet toolMode to codemode, lazy, or direct; run /reload to apply manual edits.`,
        ),
        "info",
      );
      return;
    }
    throw new Error("/firecrawl settings requires TUI or RPC mode");
  }
  const generation = currentFirecrawlSessionGeneration(pi);
  const sessionSignal = currentFirecrawlSessionSignal(pi);
  const isCurrent = () => isCurrentFirecrawlSession(pi, generation) && !sessionSignal.aborted;
  await waitForFirecrawlSettings();
  if (!isCurrent()) return;
  const settings = await loadSettings();
  if (!isCurrent()) return;
  if (settings.kind === "invalid") {
    ctx.ui.notify(
      sanitizeFirecrawlDisplay(`Firecrawl settings ignored: ${settings.reason}; repair the file before saving.`),
      "warning",
    );
  }
  let savedMode = settings.kind === "loaded" ? (settings.settings.toolMode ?? DEFAULT_TOOL_MODE) : DEFAULT_TOOL_MODE;
  let drain = Promise.resolve();
  let disposeComponent = () => {};
  try {
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      if (!isCurrent()) {
        done(undefined);
        return { render: () => [], invalidate() {} };
      }
      const controller = new AbortController();
      let pending = 0;
      let queue = Promise.resolve();
      let listOffset = 2;
      let listHeight = 0;
      const live = () => isCurrent() && !controller.signal.aborted;
      const dispose = () => {
        controller.abort();
        sessionSignal.removeEventListener("abort", close);
      };
      const close = () => {
        if (controller.signal.aborted) return;
        dispose();
        done(undefined);
      };
      disposeComponent = dispose;
      const selected = new Set(availableFirecrawlTools(pi));
      const items: SettingItem[] = [
        {
          id: "toolMode",
          label: "Tool mode",
          description:
            "Codemode: five callable tools, no loader. Lazy: loader first (eager on unsupported models). Direct: five declared tools. Saved immediately; applies after /reload.",
          currentValue: savedMode,
          values: [...FIRECRAWL_TOOL_MODES],
        },
        ...FIRECRAWL_TOOL_NAMES.map((name) => ({
          id: name,
          label: name,
          description:
            "Allow this capability. Changes apply and save immediately; closing does not undo saved changes.",
          currentValue: selected.has(name) ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        })),
      ];
      const list = new SettingsList(
        items,
        items.length,
        {
          ...getSettingsListTheme(),
          description: (text) => theme.fg("muted", text),
          // Six fixed, non-searchable rows have only the stock control hint, not scroll/result hints.
          hint: () => theme.fg("muted", settingsKeyHints(keybindings, tui)),
        },
        (id, value) => {
          if (!live()) return;
          pending += 1;
          // Register persistence at acceptance so replacement/shutdown can await it, even
          // before this screen's observer queue runs. Only runtime/UI work is session-owned.
          const modeEdit = id === "toolMode" && isFirecrawlToolMode(value);
          const save = modeEdit
            ? setFirecrawlToolMode(pi, ctx, value, sessionSignal)
            : FIRECRAWL_TOOL_NAMES.includes(id as FirecrawlToolName)
              ? setFirecrawlCapabilityEnabled(pi, ctx, id as FirecrawlToolName, value === "enabled", sessionSignal)
              : undefined;
          queue = queue
            .then(async () => {
              if (save && (await save) && isCurrent() && modeEdit && isFirecrawlToolMode(value)) savedMode = value;
            })
            .catch((error: unknown) => {
              if (isCurrent())
                ctx.ui.notify(sanitizeFirecrawlDisplay(`Firecrawl settings failed: ${String(error)}`), "warning");
            })
            .finally(() => {
              pending -= 1;
              if (!live()) return;
              if (pending === 0) {
                list.updateValue("toolMode", savedMode);
                const available = new Set(availableFirecrawlTools(pi));
                for (const name of FIRECRAWL_TOOL_NAMES)
                  list.updateValue(name, available.has(name) ? "enabled" : "disabled");
              }
              tui.requestRender();
            });
          drain = queue;
        },
        close,
      );
      // Six bounded rows need no search input; SettingsList owns navigation and value cycling.
      // Submitted settings changes drain in order even after close; disposal releases UI ownership.
      // Session replacement suppresses stale runtime/UI work, not accepted persistence.
      sessionSignal.addEventListener("abort", close, { once: true });
      return {
        render(width: number) {
          const heading = theme.fg("accent", theme.bold("Firecrawl Settings"));
          const mode = `Running: ${firecrawlToolMode(pi)}; saved: ${savedMode}${savedMode !== firecrawlToolMode(pi) ? " — /reload required" : ""}`;
          const listLines = list.render(Math.max(width, 5));
          // Mouse coordinates must follow the last rendered layout, not unpainted pending state.
          listOffset = pending > 0 ? 3 : 2;
          listHeight = listLines.length;
          return [
            heading,
            theme.fg("muted", mode),
            ...(pending > 0 ? [theme.fg("muted", "Saving changes…")] : []),
            ...listLines,
          ].map((line) => truncateToWidth(line, width));
        },
        invalidate() {
          list.invalidate();
        },
        handleInput(data: string) {
          if (!live()) return;
          if (matchesKey(data, Key.ctrl("c"))) close();
          else list.handleInput(data);
          if (live()) tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent) {
          if (!live() || event.y < listOffset || event.y >= listOffset + listHeight) return undefined;
          const result = list.handleMouse({ ...event, y: event.y - listOffset, height: listHeight });
          if (live() && result && result.render !== false) tui.requestRender();
          return result;
        },
        dispose,
        waitForPending: () => queue,
      };
    });
  } finally {
    // Release UI ownership even when the custom host fails; submitted saves still drain.
    disposeComponent();
    await drain;
  }
}
