import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  matchesKey,
  SelectList,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Text,
} from "@earendil-works/pi-tui";
import {
  HorizontalRule,
  renderBoundedFrameLayout,
  runCustomInteraction,
  sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";
import type { IllustrateMenuOwner } from "./menu.js";
import { type IllustrateSettings, validCols } from "./settings.js";

type Intent = "back" | "close" | "input";
export type SettingsScreenResult = "back" | "close" | "stale";

function current(owner: IllustrateMenuOwner): boolean {
  return !owner.signal.aborted && owner.isCurrent();
}

/** Native settings controls; accepted saves drain even when this screen closes. */
export async function showIllustrateSettings(
  ctx: ExtensionCommandContext,
  owner: IllustrateMenuOwner,
): Promise<SettingsScreenResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !current(owner)) return "stale";
  let pending = Promise.resolve();
  let pendingCount = 0;
  let refresh = () => {};
  let syncValues = (_id: keyof IllustrateSettings) => {};
  const revisions = { defaultCols: 0, mermaidAppearance: 0 };
  const report = (error: unknown) => {
    if (current(owner)) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Cannot save Illustrate settings: ${sanitizeTerminalText(reason)}`, "error");
    }
  };
  const save = (patch: Partial<IllustrateSettings>) => {
    const id = Object.hasOwn(patch, "defaultCols") ? "defaultCols" : "mermaidAppearance";
    const revision = ++revisions[id];
    pendingCount += 1;
    pending = pending.then(async () => {
      try {
        if (!current(owner)) return;
        await owner.saveSettings(patch);
        if (!current(owner)) return;
      } catch (error) {
        report(error);
      } finally {
        pendingCount -= 1;
        if (current(owner) && revisions[id] === revision) syncValues(id);
        refresh();
      }
    });
    refresh();
  };

  while (current(owner)) {
    const result = await runCustomInteraction<Intent>(ctx, {
      signal: owner.signal,
      isCurrent: () => owner.isCurrent(),
      blocked: { kind: "question", message: "Illustrate settings" },
      onError: (_ctx, error) => report(error),
      create: ({ tui, theme, keybindings, complete }) => {
        let disposed = false;
        let submenu = false;
        let renderedLabel = 0;
        let focusedListRow = 0;
        let submenuFocusedRow = () => 0;
        let nativeRows = new Map<number, number>();
        let nativeHeight = 0;
        let nativeWidth = 0;
        const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
        const settings = owner.getSettings();
        const items: SettingItem[] = [
          {
            id: "defaultCols",
            label: "Default width",
            description: "Width for later calls that omit cols. Auto follows the available columns.",
            currentValue: String(settings.defaultCols),
            submenu: (value, done) => {
              submenu = true;
              const choices = new SelectList(
                [
                  { value: "auto", label: "Auto", description: "Use the available width" },
                  { value: "custom", label: "Custom columns…", description: "Enter a positive safe integer" },
                ],
                2,
                {
                  selectedPrefix: (text) => theme.fg("accent", text),
                  selectedText: (text) => theme.fg("accent", text),
                  description: (text) => theme.fg("muted", text),
                  scrollInfo: (text) => theme.fg("muted", text),
                  noMatch: (text) => theme.fg("warning", text),
                },
              );
              choices.setSelectedIndex(value === "auto" ? 0 : 1);
              submenuFocusedRow = () => (choices.getSelectedItem()?.value === "auto" ? 0 : 1);
              choices.onSelect = (item) => {
                submenu = false;
                if (item.value === "custom") {
                  done();
                  complete("input");
                } else done("auto");
              };
              choices.onCancel = () => {
                submenu = false;
                done();
              };
              return choices;
            },
          },
          {
            id: "mermaidAppearance",
            label: "Mermaid appearance",
            description: "Auto follows Pi appearance. Changes refresh existing Mermaid previews.",
            currentValue: settings.mermaidAppearance,
            values: ["auto", "dark", "light"],
          },
        ];
        const listTheme: SettingsListTheme = {
          ...getSettingsListTheme(),
          label: (text, selected) => {
            if (selected) focusedListRow = renderedLabel;
            renderedLabel += 1;
            return selected ? theme.fg("accent", text) : text;
          },
          value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
          description: (text) => theme.fg("muted", text),
          cursor: "",
          // Native SettingsList hard-codes Enter/Escape hints. Omit those false
          // hints under remapped bindings; all key dispatch remains native.
          hint: () => "",
        };
        const list = new SettingsList(
          items,
          2,
          listTheme,
          (id, value) => {
            if (id === "defaultCols" && value === "auto") save({ defaultCols: "auto" });
            if (id === "mermaidAppearance" && (value === "auto" || value === "dark" || value === "light")) {
              save({ mermaidAppearance: value });
            }
          },
          () => complete("back"),
        );
        const updateValues = (id: keyof IllustrateSettings) => {
          list.updateValue(id, String(owner.getSettings()[id]));
        };
        syncValues = updateValues;
        refresh = () => {
          if (!disposed && current(owner)) tui.requestRender();
        };
        return {
          capturesViewportInput: list.capturesViewportInput,
          render(width) {
            const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
            renderedLabel = 0;
            listTheme.cursor = theme.fg("accent", "→ ");
            const content = list.render(safeWidth);
            if (pendingCount > 0) content.push(theme.fg("muted", "Saving…"));
            const focusedRow = submenu ? submenuFocusedRow() : focusedListRow;
            const rows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
            const frame = renderBoundedFrameLayout({
              width: safeWidth,
              maxRows: Math.max(1, rows - 3),
              rule: rule.render(safeWidth)[0] ?? "",
              title: new Text(theme.fg("accent", theme.bold("Illustrate Settings")), 0, 0).render(safeWidth),
              context: [
                ...new Text(theme.fg("muted", `User: ${sanitizeTerminalText(owner.settingsPath)}`), 0, 0).render(
                  safeWidth,
                ),
                ...new Text(
                  theme.fg("muted", "Changes save immediately. Closing does not undo saved changes."),
                  0,
                  0,
                ).render(safeWidth),
              ],
              content,
              priorityRows: focusedRow < 0 ? [] : [focusedRow],
              focusedRow,
            });
            nativeRows = new Map(frame.contentRows.map(({ frameIndex, contentIndex }) => [frameIndex, contentIndex]));
            nativeHeight = content.length;
            nativeWidth = safeWidth;
            return frame.lines;
          },
          invalidate() {
            nativeRows.clear();
            list.invalidate();
          },
          handleInput(data) {
            if (disposed || !current(owner) || isKeyRelease(data)) return;
            if (matchesKey(data, Key.ctrl("c"))) {
              complete("close");
              return;
            }
            // Native selection actions keep their normal order, including Space.
            // The callback manager owns outer cancellation; submenu Back stays native.
            if (
              !submenu &&
              keybindings.matches(data, "tui.select.cancel") &&
              !(
                [
                  "tui.select.up",
                  "tui.select.down",
                  "tui.select.pageUp",
                  "tui.select.pageDown",
                  "tui.select.confirm",
                ] as const
              ).some((binding) => keybindings.matches(data, binding)) &&
              data !== " "
            )
              complete("back");
            else list.handleInput(data);
            nativeRows.clear();
            refresh();
          },
          handleMouse(event) {
            if (disposed || !current(owner)) return;
            const y = nativeRows.get(event.y);
            if (y === undefined || event.x < 0 || event.x >= nativeWidth) return;
            const handled = list.handleMouse({ ...event, y, height: nativeHeight });
            // Pi dispatches release and synthesized click before the next frame.
            // Keep the published press geometry until activation or a real layout change.
            if (event.type === "click" || event.type === "wheel") nativeRows.clear();
            refresh();
            return handled;
          },
          dispose() {
            disposed = true;
            nativeRows.clear();
            refresh = () => {};
          },
          waitForPending: () => pending,
        };
      },
    });
    if (!current(owner) || result.kind !== "completed") return "stale";
    if (result.value !== "input") return result.value;

    // Drain the custom interaction before opening Pi's input. Pi owns input
    // focus, editing bindings, and bracketed paste; only hard Close is added.
    const inputController = new AbortController();
    const signal = AbortSignal.any([owner.signal, inputController.signal]);
    let hardClose = false;
    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data)) return undefined;
      // A complete paste packet never matches a standalone key. A separate
      // Ctrl+C remains a hard Close even during an unfinished paste.
      if (matchesKey(data, Key.ctrl("c"))) {
        hardClose = true;
        inputController.abort();
        return { consume: true };
      }
      return undefined;
    });
    let value: string | undefined;
    try {
      value = await ctx.ui.input("Default width in columns", "Positive safe integer", { signal });
    } finally {
      unsubscribe();
      inputController.abort();
    }
    if (!current(owner)) return "stale";
    if (hardClose) return "close";
    if (value !== undefined) {
      const number = /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : NaN;
      if (!validCols(number)) ctx.ui.notify("Width must be a positive safe integer.", "error");
      else {
        save({ defaultCols: number });
        await pending;
        if (!current(owner)) return "stale";
      }
    }
  }
  return "stale";
}
