import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Text,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { sanitizeProgressText } from "./progress-renderer.js";
import { PROGRESS_DISPLAY_MODES, type ProgressSettings } from "./settings.js";

interface ProgressSettingsUIOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  get(): ProgressSettings;
  save(patch: Partial<ProgressSettings>, signal: AbortSignal): Promise<ProgressSettings>;
  apply(settings: ProgressSettings): void;
}

export async function showProgressSettings(
  ctx: ExtensionCommandContext,
  options: ProgressSettingsUIOptions,
): Promise<"back" | "close" | "stale"> {
  const { formatInteractionHints, HorizontalRule, renderBoundedFrameLayout, runCustomInteraction } = await import(
    "@narumitw/pi-tui-kit"
  );
  const result = await runCustomInteraction<"back" | "close" | "stale">(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    // The command owner reports interaction failures after pending saves drain.
    onError: () => {},
    create({ tui, theme, keybindings, signal, complete }) {
      let queue = Promise.resolve();
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      const revisions = new Map<string, number>();
      const mouseRows = new Map<number, number>();
      let renderedWidth = 0;
      let contentHeight = 0;
      let mousePressed = false;
      let itemLimitInput: Input | undefined;
      let itemLimitPasting = false;
      let focused = false;
      const current = () => !signal.aborted && options.isCurrent();
      const initial = options.get();
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Show widget",
          description: "Show progress above the editor.",
          currentValue: String(initial.enabled),
          values: ["true", "false"],
        },
        {
          id: "displayMode",
          label: "Display mode",
          description: "Use adaptive, expanded, or collapsed display.",
          currentValue: initial.displayMode,
          values: [...PROGRESS_DISPLAY_MODES],
        },
        {
          id: "showCompleted",
          label: "Show completed",
          description: "Include completed steps in the progress display.",
          currentValue: String(initial.showCompleted),
          values: ["true", "false"],
        },
        {
          id: "maxVisibleItems",
          label: "Visible item limit",
          description: "Enter a number from 1 to 50. Leave the field blank for no limit.",
          currentValue: formatValue(initial.maxVisibleItems),
          submenu(value, finish) {
            const input = new Input({
              placeholder: "No limit",
              placeholderStyle: (text) => theme.fg("muted", text),
            });
            const unsafePreview = new Input({
              placeholder: "Invalid pasted text",
              placeholderStyle: (text) => theme.fg("error", text),
            });
            input.setValue(value === "none" ? "" : value);
            input.focused = focused;
            itemLimitInput = input;
            let error = "";
            const unsafe = () => sanitizeTerminalDocument(input.getValue()) !== input.getValue();
            const finishInput = (next?: string) => {
              if (!current() || itemLimitInput !== input) return;
              input.focused = false;
              itemLimitInput = undefined;
              itemLimitPasting = false;
              mousePressed = false;
              mouseRows.clear();
              finish(next);
            };
            input.onSubmit = (draft) => {
              if (!current() || itemLimitInput !== input) return;
              const text = draft.trim();
              const limit = Number(text);
              if (
                unsafe() ||
                (text !== "" && (!/^\d+$/u.test(text) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50))
              ) {
                error = "Enter a whole number from 1 to 50, or leave the field blank.";
                ctx.ui.notify(error, "warning");
                return;
              }
              finishInput(text === "" ? "none" : String(limit));
            };
            input.onEscape = () => finishInput();
            const handleInput = (data: string): void => {
              if (!current()) return;
              if (!itemLimitPasting && matchesKey(data, Key.ctrl("c"))) {
                complete("close");
                return;
              }
              if (itemLimitInput !== input) {
                list.handleInput(data);
                return;
              }
              if (data.includes("\u001b[200~")) itemLimitPasting = true;
              const end = itemLimitPasting ? data.indexOf("\u001b[201~") : -1;
              if (end >= 0 && end + 6 < data.length) {
                input.handleInput(data.slice(0, end + 6));
                itemLimitPasting = false;
                handleInput(data.slice(end + 6));
                return;
              }
              input.handleInput(data);
              if (end >= 0) itemLimitPasting = false;
            };
            return {
              render(width: number) {
                // Keep unsafe pasted bytes in the draft for rejection, but never render their controls.
                unsafePreview.focused = input.focused;
                const hint = formatInteractionHints(keybindings, [
                  {
                    bindings: ["tui.input.submit"],
                    excludeKeys: [...keybindings.getKeys("tui.select.cancel"), "ctrl+c"],
                    label: "save",
                  },
                  { bindings: ["tui.select.cancel"], excludeKeys: ["ctrl+c"], label: "back" },
                  { keys: ["ctrl+c"], label: "close" },
                ]);
                return [
                  ...(unsafe() ? unsafePreview : input).render(width),
                  ...new Text(theme.fg("muted", "Enter 1–50. Blank means no limit."), 0, 0).render(width),
                  ...(error ? new Text(theme.fg("error", error), 0, 0).render(width) : []),
                  ...new Text(theme.fg("muted", hint), 0, 0).render(width),
                ];
              },
              invalidate() {
                input.invalidate();
                unsafePreview.invalidate();
              },
              handleInput,
              handleMouse(event: TuiMouseEvent) {
                // The safe placeholder is not the raw draft, so it has no mouse cursor target.
                return unsafe() ? undefined : input.handleMouse(event);
              },
            };
          },
        },
        {
          id: "showProgress",
          label: "Show completion count",
          description: "Show the completed and total step counts in the header.",
          currentValue: String(initial.showProgress),
          values: ["true", "false"],
        },
      ];
      const list = new SettingsList(
        items,
        items.length,
        getSettingsListTheme(),
        (id, value) => {
          if (!current()) return;
          const key = id as keyof ProgressSettings;
          const requested =
            key === "maxVisibleItems"
              ? value === "none"
                ? null
                : Number(value)
              : key === "displayMode"
                ? value
                : value === "true";
          const revision = (revisions.get(id) ?? 0) + 1;
          revisions.set(id, revision);
          queue = queue.then(async () => {
            if (!current()) return;
            try {
              const settings = await options.save({ [key]: requested }, signal);
              // Successful return means publication completed, even if the screen closed during rename.
              if (!options.isCurrent()) return;
              options.apply(settings);
            } catch (error) {
              if (!current()) return;
              ctx.ui.notify(
                sanitizeProgressText(
                  `Could not save pi-progress.json: ${error instanceof Error ? error.message : String(error)}`,
                ),
                "error",
              );
            }
            if (!current()) return;
            if (revisions.get(id) === revision) list.updateValue(id, formatValue(options.get()[key]));
            tui.requestRender();
          });
        },
        () => complete("back"),
      );
      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          if (itemLimitInput) itemLimitInput.focused = value;
        },
        render(width: number) {
          renderedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
          // Native rows need four cells to retain their cursor; Kit clips the final frame.
          const content = list.render(Math.max(4, renderedWidth));
          contentHeight = content.length;
          mouseRows.clear();

          const focusedRow = itemLimitInput
            ? 0
            : content.findIndex((line) => stripVTControlCharacters(line).startsWith("→"));
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const frame = renderBoundedFrameLayout({
            width: renderedWidth,
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(renderedWidth)[0] ?? "",
            title: new Text(
              theme.fg("accent", theme.bold(itemLimitInput ? "Visible item limit" : "Progress Settings")),
              0,
              0,
            ).render(renderedWidth),
            context: [theme.fg("muted", "Saved changes apply immediately.")],
            content,
            priorityRows: focusedRow < 0 ? [] : [focusedRow],
            focusedRow,
          });
          for (const { frameIndex, contentIndex } of frame.contentRows) mouseRows.set(frameIndex, contentIndex);
          return frame.lines;
        },
        invalidate() {
          mouseRows.clear();
          mousePressed = false;
          list.invalidate();
        },
        handleMouse(event: TuiMouseEvent) {
          if (!current()) return;
          const nativeRow = mouseRows.get(event.y);
          if (nativeRow === undefined || event.x < 0 || event.x >= renderedWidth) {
            if (event.button === "left" && (event.type === "press" || event.type === "click")) mousePressed = false;
            return;
          }
          const nativeEvent = { ...event, y: nativeRow, width: renderedWidth, height: contentHeight };
          // Replace a stale native press before a new click without a matching owned press.
          if (event.type === "click" && event.button === "left" && !mousePressed) {
            list.handleMouse({ ...nativeEvent, type: "press" });
          }
          const result = list.handleMouse(nativeEvent);
          if (event.type === "press" && event.button === "left") mousePressed = result?.handled === true;
          if (event.type === "click" || event.type === "wheel") mousePressed = false;
          if (result?.handled && result.render !== false) tui.requestRender();
          return result;
        },
        handleInput(data: string) {
          if (!current()) return;
          mousePressed = false;
          mouseRows.clear();
          if (!itemLimitPasting && matchesKey(data, Key.ctrl("c"))) complete("close");
          else list.handleInput(data);
          tui.requestRender();
        },
        waitForPending() {
          return queue;
        },
        dispose() {
          if (itemLimitInput) itemLimitInput.focused = false;
          itemLimitInput = undefined;
          itemLimitPasting = false;
          mouseRows.clear();
          mousePressed = false;
        },
      };
    },
  });
  if (result.kind === "error") throw result.error;
  return result.kind === "completed" ? result.value : result.kind === "unsupported" ? "back" : "stale";
}

function formatValue(value: ProgressSettings[keyof ProgressSettings]): string {
  return value === null ? "none" : String(value);
}
