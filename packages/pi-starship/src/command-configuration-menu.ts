import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, SelectList } from "@earendil-works/pi-tui";
import {
  formatInteractionHints,
  HorizontalRule,
  hardWrapTerminalDocument,
  renderBoundedFrameLayout,
  runCustomInteraction,
} from "@narumitw/pi-tui-kit";
import {
  type ConfigurationCommandOptions,
  configurationMenuScreen,
  type WorkflowOwner,
} from "./command-configuration.js";

type ConfigurationAction = ReturnType<typeof configurationMenuScreen>["items"][number]["action"];

/** Kit action headers do not scroll. Keep this extension-owned summary viewport above a native SelectList. */
export function showConfigurationMenu(
  ctx: ExtensionCommandContext,
  options: ConfigurationCommandOptions,
  owner: WorkflowOwner,
  selected?: string,
) {
  return runCustomInteraction<ConfigurationAction | "back" | "close">(ctx, {
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    create: ({ tui, theme, keybindings, complete }) => {
      const screen = configurationMenuScreen(options.getLoaded(), options.settingsPath);
      const list = new SelectList(
        screen.items.map((item) => ({ value: item.action, label: item.label, description: item.description })),
        4,
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("muted", text),
          noMatch: (text) => theme.fg("muted", text),
        },
      );
      let index = Math.max(
        0,
        screen.items.findIndex((item) => item.action === selected),
      );
      list.setSelectedIndex(index);
      let offset = 0;
      let pageSize = 1;
      let lastOffset = 0;
      let disposed = false;
      let layout: ReturnType<typeof renderBoundedFrameLayout> | undefined;
      let listStart = 0;
      let lastWidth = 0;
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      const scroll = (direction: number) => {
        offset = Math.max(0, Math.min(lastOffset, offset + direction * pageSize));
        tui.requestRender();
      };
      return {
        render(width) {
          if (disposed) return [];
          lastWidth = width;
          const rows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const maxRows = Math.max(1, rows - 3);
          const summary = hardWrapTerminalDocument(screen.lines.join("\n"), width);
          const listRows = list.render(width);
          const description = screen.items[index]?.description;
          const details =
            description && !listRows.some((line) => stripVTControlCharacters(line).includes(description))
              ? hardWrapTerminalDocument(description, width).map((line) => theme.fg("muted", line))
              : [];
          pageSize = Math.max(1, maxRows - 11 - (details.length ? details.length + 1 : 0));
          lastOffset = Math.max(0, summary.length - pageSize);
          offset = Math.min(offset, lastOffset);
          const visibleSummary = summary.slice(offset, offset + pageSize).map((line) => theme.fg("muted", line));
          const status =
            lastOffset > 0
              ? [
                  theme.fg(
                    "muted",
                    `Summary ${offset + 1}-${Math.min(summary.length, offset + pageSize)}/${summary.length} · Page navigation scrolls summary`,
                  ),
                ]
              : [];
          listStart = visibleSummary.length + status.length + 1;
          const detailStart = listStart + listRows.length + 1;
          const content = [...visibleSummary, ...status, "", ...listRows, ...(details.length ? ["", ...details] : [])];
          const hints = formatInteractionHints(keybindings, [
            { bindings: ["tui.select.up", "tui.select.down"], label: "navigate" },
            { bindings: ["tui.select.confirm"], label: "select" },
            { bindings: ["tui.select.cancel"], label: "back" },
          ]);
          layout = renderBoundedFrameLayout({
            width,
            maxRows,
            rule: rule.render(width)[0] ?? "",
            title: [theme.fg("accent", theme.bold(screen.title))],
            content,
            hints: [theme.fg("muted", `${hints} • ctrl+c close`)],
            compactHint: "",
            focusedRow: listStart + index,
            priorityRows: [listStart + index, ...details.map((_, index) => detailStart + index)],
          });
          return layout.lines;
        },
        invalidate() {
          layout = undefined;
          list.invalidate();
        },
        handleInput(data) {
          if (disposed || isKeyRelease(data)) return;
          // Standard selection and cancellation take priority over summary scrolling.
          if (matchesKey(data, Key.ctrl("c"))) complete("close");
          else if (keybindings.matches(data, "tui.select.cancel")) complete("back");
          else if (keybindings.matches(data, "tui.select.up")) {
            index = (index + screen.items.length - 1) % screen.items.length;
            list.setSelectedIndex(index);
          } else if (keybindings.matches(data, "tui.select.down")) {
            index = (index + 1) % screen.items.length;
            list.setSelectedIndex(index);
          } else if (matchesKey(data, Key.home)) {
            index = 0;
            list.setSelectedIndex(index);
          } else if (matchesKey(data, Key.end)) {
            index = screen.items.length - 1;
            list.setSelectedIndex(index);
          } else if (keybindings.matches(data, "tui.select.confirm")) {
            const item = screen.items[index];
            if (item) complete(item.action);
          } else if (keybindings.matches(data, "tui.select.pageUp")) scroll(-1);
          else if (keybindings.matches(data, "tui.select.pageDown")) scroll(1);
          tui.requestRender();
        },
        handleMouse(event) {
          if (disposed || !layout || event.width !== lastWidth) return undefined;
          const row = layout.contentRows.find((row) => row.frameIndex === event.y)?.contentIndex;
          if (row === undefined) return undefined;
          if (row < listStart) {
            if (event.type !== "wheel" || !event.wheelDelta) return undefined;
            scroll(event.wheelDelta < 0 ? -1 : 1);
            return { handled: true, render: true };
          }
          const result = list.handleMouse({ ...event, y: row - listStart });
          index = screen.items.findIndex((item) => item.action === list.getSelectedItem()?.value);
          const item = screen.items[index];
          if (event.type === "click" && result?.handled && item) complete(item.action);
          return result;
        },
        dispose() {
          disposed = true;
        },
      };
    },
  });
}
