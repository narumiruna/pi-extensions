import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  HorizontalRule,
  renderBoundedFrameLayout,
  runCustomInteraction,
  sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";
import type { EditorStatusMode, EditorStatusTrigger } from "@narumitw/pi-tui-kit/editor-status-view";
import type { SubagentSettings } from "./settings.js";
import type { SubagentWidgetControls } from "./widget.js";
import { renderSubagentWidgetPreview } from "./widget-preview.js";

interface SubagentSettingsUIOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  get(): SubagentSettings;
  widget?: SubagentWidgetControls;
  save(key: keyof SubagentSettings, value: boolean, signal: AbortSignal): Promise<SubagentSettings>;
  apply(settings: SubagentSettings): void;
}

type CloseReason = "back" | "close" | "stale";

const SETTINGS: { key: keyof SubagentSettings; label: string; description: string }[] = [
  {
    key: "showWidget",
    label: "Show widget",
    description: "Allow the subagent status above the editor across sessions.",
  },
  { key: "showJobId", label: "Show job ID", description: "Show job IDs in the widget." },
  { key: "showTools", label: "Show tools", description: "Show active tools in the widget." },
  { key: "showTiming", label: "Show timing", description: "Show job timing in the widget." },
];

const STATUS_VIEWS = [
  { value: "expanded", label: "Job rows", description: "Show a row for each active job." },
  { value: "compact", label: "Counts only", description: "Show just the number of running and queued jobs." },
  { value: "hidden", label: "Hidden", description: "Hide the status without stopping any jobs." },
] as const satisfies readonly Choice<EditorStatusMode>[];

const AUTO_SUMMARY = [
  { value: "manual", label: "Off", description: "Never switch to counts automatically." },
  {
    value: "user-message",
    label: "On next message",
    description: "Switch when Pi starts processing your next message.",
  },
  {
    value: "settled-cycle",
    label: "After next reply",
    description: "Switch after Pi finishes responding to a later message without error.",
  },
] as const satisfies readonly Choice<EditorStatusTrigger>[];

type Choice<T extends string = string> = { value: T; label: string; description: string };

export async function showSubagentSettings(
  ctx: ExtensionCommandContext,
  options: SubagentSettingsUIOptions,
): Promise<CloseReason> {
  const result = await runCustomInteraction<CloseReason>(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    // The command owner reports interaction failures and non-TUI settings paths.
    onError: () => {},
    create({ tui, theme, signal, complete }) {
      let queue = Promise.resolve();
      const current = () => !signal.aborted && options.isCurrent();
      const revisions = new Map<string, number>();
      const pending = new Map<string, number>();
      const mouseRows = new Map<number, number>();
      let renderedWidth = 0;
      let contentHeight = 0;
      let mousePressed = false;
      const reportFailure = (message: string, title = "Could not save pi-subagents.json") => {
        if (!current()) return;
        try {
          ctx.ui.notify(sanitizeTerminalText(`${title}: ${message}`), "error");
        } catch {
          // The host can dispose its notifier after the ownership check.
        }
      };
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      const previewRule = new HorizontalRule({ ruleStyle: (text) => theme.fg("borderMuted", text) });
      // Keep native SettingsList semantics, but use this screen's callback theme.
      const listTheme = {
        ...getSettingsListTheme(),
        label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
        value: (text: string, selected: boolean) => theme.fg(selected ? "accent" : "muted", text),
        description: (text: string) => theme.fg("dim", text),
        cursor: theme.fg("accent", "→ "),
        hint: (text: string) => theme.fg("dim", text),
      };
      const widget = options.widget;
      let chooser: { list: SelectList; choices: readonly Choice[] } | undefined;
      const choose =
        (choices: readonly Choice[]): NonNullable<SettingItem["submenu"]> =>
        (value, done) => {
          const list = new SelectList(
            choices.map((choice) => ({ ...choice, value: choice.label })),
            choices.length,
            {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: listTheme.hint,
              noMatch: listTheme.hint,
            },
            { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 20 },
          );
          list.setSelectedIndex(choices.findIndex((choice) => choice.label === value));
          list.onSelect = (item) => {
            chooser = undefined;
            done(item.value);
          };
          list.onCancel = () => {
            chooser = undefined;
            done();
          };
          chooser = { list, choices };
          return list;
        };
      const initial = options.get();
      const flags = SETTINGS.map(({ key, label, description }) => ({
        id: key,
        label,
        description,
        currentValue: String(initial[key]),
        values: ["true", "false"],
      }));
      const items: SettingItem[] = [...flags];
      if (widget) {
        items.push(
          {
            id: "statusView",
            label: "Status view",
            description: "Change the status above the editor for this session. Only active jobs appear there.",
            currentValue: "",
            submenu: choose(STATUS_VIEWS),
          },
          {
            id: "pinView",
            label: "Pin status view",
            description: "Prevent automatic switching to counts for this session.",
            currentValue: "",
            values: ["No", "Yes"],
          },
          {
            id: "autoSummary",
            label: "Switch to counts",
            description:
              "Automatically switch once in this session. Pinned, hidden, or disabled status does not switch.",
            currentValue: "",
            submenu: choose(AUTO_SUMMARY),
          },
          {
            id: "resetRows",
            label: "Restore job rows",
            description: "Undo per-job changes from Jobs without changing the status view.",
            currentValue: "Restore",
            values: ["Restore"],
          },
        );
      }
      const list = new SettingsList(
        items,
        items.length,
        listTheme,
        (id, value) => {
          if (!current()) return;
          const setting = SETTINGS.find(({ key }) => key === id);
          if (!setting) {
            if (!widget) return;
            try {
              if (id === "statusView") {
                const choice = STATUS_VIEWS.find(({ label }) => label === value);
                if (choice) widget.setMode(choice.value);
              } else if (id === "pinView") widget.setPinned(value === "Yes");
              else if (id === "autoSummary") {
                const choice = AUTO_SUMMARY.find(({ label }) => label === value);
                if (choice) widget.setTrigger(choice.value);
              } else if (id === "resetRows") widget.resetItems();
            } catch (error) {
              reportFailure(error instanceof Error ? error.message : String(error), "Could not update subagent status");
            }
            return;
          }
          const { key } = setting;
          const revision = (revisions.get(id) ?? 0) + 1;
          revisions.set(id, revision);
          pending.set(id, revision);
          queue = queue
            .then(async () => {
              if (!current()) {
                complete("stale");
                return;
              }
              const before = { ...options.get() };
              let effective = before;
              try {
                const settings = await options.save(key, value === "true", signal);
                // A successful rename is durable, even when closing aborted the save signal.
                if (!options.isCurrent()) {
                  complete("stale");
                  return;
                }
                options.apply(settings);
                effective = options.get();
              } catch (error) {
                if (!options.isCurrent()) {
                  complete("stale");
                  return;
                }
                let message = error instanceof Error ? error.message : String(error);
                try {
                  options.apply(before);
                } catch (rollbackError) {
                  message += `; could not restore effective settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
                }
                reportFailure(message);
              }
              if (!current()) return;
              if (pending.get(id) === revision) pending.delete(id);
              // Saving rereads the full document, including unrelated manual edits. Keep newer
              // optimistic choices, but refresh every row with no outstanding user change.
              for (const { key: settingKey } of SETTINGS) {
                if (!pending.has(settingKey)) list.updateValue(settingKey, String(effective[settingKey]));
              }
              tui.requestRender();
            })
            .catch((error: unknown) => {
              // A failed action must not prevent later requests from entering the queue.
              reportFailure(error instanceof Error ? error.message : String(error));
            });
        },
        () => complete("back"),
      );
      return {
        get capturesViewportInput() {
          return list.capturesViewportInput;
        },
        render(width: number) {
          if (!current()) complete("stale");
          renderedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
          listTheme.cursor = theme.fg("accent", "→ ");
          // The native footer hardcodes keys. Advertise only the hard-cancel key owned here;
          // configured native navigation, change, and Back actions remain unchanged.
          const view = current() ? widget?.state() : undefined;
          if (view) {
            const mode = view.mode === "default" ? "expanded" : view.mode;
            list.updateValue("statusView", STATUS_VIEWS.find(({ value }) => value === mode)?.label ?? "");
            list.updateValue("autoSummary", AUTO_SUMMARY.find(({ value }) => value === view.trigger)?.label ?? "");
            list.updateValue("pinView", view.pinned ? "Yes" : "No");
          }
          const content = list.render(Math.max(4, renderedWidth)).slice(0, chooser ? undefined : -2);
          const nativeRows = content.map((line, index): { line: string; nativeIndex?: number } => ({
            line,
            nativeIndex: index,
          }));
          const preview: string[] = [];
          if (view) {
            const draft = { ...initial };
            for (const { id, currentValue } of flags) draft[id] = currentValue === "true";
            const highlighted = chooser?.choices === STATUS_VIEWS ? chooser.list.getSelectedItem()?.value : undefined;
            const previewMode = STATUS_VIEWS.find(({ label }) => label === highlighted)?.value ?? view.mode;
            preview.push(
              theme.fg("muted", "Preview · sample jobs"),
              ...renderSubagentWidgetPreview(draft, previewMode, theme, renderedWidth),
              ...previewRule.render(renderedWidth),
            );
          }
          contentHeight = content.length;
          const nativeFocus = content.findIndex((line) => stripVTControlCharacters(line).startsWith("→"));
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const title = new Text(theme.fg("accent", theme.bold("Subagents Settings")), 0, 0).render(renderedWidth);
          const frameOptions = {
            width: renderedWidth,
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(renderedWidth)[0] ?? "",
            hints: new Text(theme.fg("muted", "Ctrl+C close"), 0, 0).render(renderedWidth),
          };
          const renderFrame = (rows: typeof nativeRows, showPreview: boolean) => {
            const focusedRow = rows.findIndex(({ nativeIndex }) => nativeIndex === nativeFocus);
            return renderBoundedFrameLayout({
              ...frameOptions,
              title: showPreview ? [...title, ...preview] : title,
              content: rows.map(({ line }) => line),
              priorityRows: focusedRow < 0 ? [] : [focusedRow],
              focusedRow,
            });
          };
          let groupRows: typeof nativeRows | undefined;
          if (view && !chooser) {
            const heading = (label: string) => ({ line: theme.fg("muted", theme.bold(label)) });
            groupRows = [
              heading("Saved preferences"),
              ...nativeRows.slice(0, flags.length),
              heading("This session"),
              ...nativeRows.slice(flags.length, items.length),
            ];
          }
          let rows = groupRows
            ? [...groupRows, ...nativeRows.slice(items.length).filter(({ line }) => line.trim() !== "")]
            : nativeRows;
          let frame = renderFrame(rows, true);
          if (groupRows && frame.contentRows.length < rows.length) {
            const previewFrame = renderFrame(groupRows, true);
            if (previewFrame.contentRows.length === groupRows.length) {
              rows = groupRows;
              frame = previewFrame;
            } else {
              frame = renderFrame(rows, false);
              if (frame.contentRows.length < rows.length) {
                rows = nativeRows;
                frame = renderFrame(rows, false);
              }
            }
          }
          mouseRows.clear();
          for (const { frameIndex, contentIndex } of frame.contentRows) {
            const nativeIndex = rows[contentIndex]?.nativeIndex;
            if (nativeIndex !== undefined) mouseRows.set(frameIndex, nativeIndex);
          }
          return frame.lines;
        },
        invalidate() {
          mouseRows.clear();
          mousePressed = false;
          list.invalidate();
        },
        handleInput(data: string) {
          if (!current()) return complete("stale");
          mouseRows.clear();
          mousePressed = false;
          if (matchesKey(data, Key.ctrl("c"))) complete("close");
          else {
            // SettingsList uses Pi's effective native keybindings for standard actions.
            list.handleInput(data);
          }
          tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent) {
          if (!current()) {
            complete("stale");
            return;
          }
          const nativeRow = mouseRows.get(event.y);
          if (nativeRow === undefined || event.x < 0 || event.x >= renderedWidth) {
            if (event.button === "left" && (event.type === "press" || event.type === "click")) mousePressed = false;
            return;
          }
          const nativeEvent = { ...event, y: nativeRow, width: renderedWidth, height: contentHeight };
          if (event.type === "click" && event.button === "left" && !mousePressed) {
            list.handleMouse({ ...nativeEvent, type: "press" });
          }
          const result = list.handleMouse(nativeEvent);
          if (event.type === "press" && event.button === "left") mousePressed = result?.handled === true;
          if (event.type === "click" || event.type === "wheel") mousePressed = false;
          if (result?.handled && result.render !== false) tui.requestRender();
          return result;
        },
        waitForPending() {
          return queue;
        },
        dispose() {
          mouseRows.clear();
          mousePressed = false;
        },
      };
    },
  });
  if (result.kind === "error") throw result.error;
  return result.kind === "completed" ? result.value : result.kind === "unsupported" ? "back" : "stale";
}
