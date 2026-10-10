import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, type TUI, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { HorizontalRule, hardWrapTerminalDocument, sanitizeTerminalText } from "@narumitw/pi-tui-kit";

export type SyncConfirmationChoice = "cancel" | "approve" | "details";

/** Kit choice context is clipped on short terminals; this summary must remain reviewable. */
export function createSyncConfirmation(options: {
  title: string;
  lines: readonly string[];
  confirmationLabel: string;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  complete(choice: SyncConfirmationChoice): void;
}) {
  const { tui, theme, keybindings } = options;
  const choices: SyncConfirmationChoice[] = ["cancel", "approve", "details"];
  const list = new SelectList(
    [
      { value: "cancel", label: "No, cancel" },
      { value: "approve", label: `Yes, ${sanitizeTerminalText(options.confirmationLabel)}` },
      { value: "details", label: "View details" },
    ],
    3,
    {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("muted", text),
    },
  );
  const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
  let selected = 0;
  let offset = 0;
  let maximumOffset = 0;
  let lastWidth = 0;
  let lastRows = 0;
  let seen = new Set<number>();
  let summary: readonly string[] = [];
  let reviewed = false;
  let disposed = false;
  let finished = false;
  let summaryStart = 0;
  let summaryEnd = 0;
  let actionsStart = 0;
  const finish = (choice: SyncConfirmationChoice) => {
    if (disposed || finished) return;
    finished = true;
    options.complete(choice);
  };
  const select = (index: number) => {
    selected = (index + choices.length) % choices.length;
    list.setSelectedIndex(selected);
  };
  list.onSelectionChange = (item) => {
    selected = Math.max(0, choices.indexOf(item.value as SyncConfirmationChoice));
  };
  list.onSelect = (item) => {
    const choice = choices[selected] ?? "cancel";
    if (item.value === choice && (choice !== "approve" || reviewed)) finish(choice);
  };
  const component = {
    render(width: number, expose = true): string[] {
      if (!Number.isFinite(width) || width <= 0) {
        reviewed = false;
        return [];
      }
      const cells = Math.floor(width);
      const rows = Math.max(1, Math.floor(tui.terminal.rows) - 3);
      if (cells !== lastWidth || rows !== lastRows) {
        // Reflow can expose previously unseen rows or hide the selected action.
        // Reset proof and selection rather than carry approval across a resize.
        summary = options.lines.flatMap((line) => hardWrapTerminalDocument(line, cells));
        seen = new Set();
        offset = 0;
        select(0);
        lastWidth = cells;
        lastRows = rows;
      }
      const framed = rows >= 9;
      const actions = list.render(cells);
      const viewport = Math.max(0, rows - actions.length - 3 - (framed ? 2 : 0));
      maximumOffset = Math.max(0, summary.length - viewport);
      offset = Math.min(offset, maximumOffset);
      const visible = summary.slice(offset, offset + viewport);
      if (expose) for (let index = offset; index < offset + visible.length; index++) seen.add(index);
      reviewed = viewport > 0 && seen.size === summary.length;
      // Describe actions without advertising configured keys that can be invalid,
      // aliased, or shadowed by an earlier cancellation/navigation binding.
      const hint = reviewed ? "Select an action." : "Navigation keys scroll the summary before selecting Yes.";
      const body = [
        theme.fg("accent", theme.bold(hardWrapTerminalDocument(options.title, cells).join(" "))),
        ...visible.map((line) => theme.fg("text", line)),
        theme.fg(
          "muted",
          `Summary ${visible.length ? offset + 1 : 0}-${offset + visible.length}/${summary.length}${reviewed ? "" : " — review before Yes"}`,
        ),
        ...actions,
        theme.fg("dim", hint),
      ];
      summaryStart = Number(framed) + 1;
      summaryEnd = summaryStart + visible.length;
      actionsStart = summaryEnd + 1;
      const frame = framed ? [...rule.render(cells), ...body, ...rule.render(cells)] : body;
      // Very small terminals cannot display the summary and all choices together.
      // Keep cancellation available, but never approve a zero-row summary viewport.
      return frame.slice(0, rows).map((line) => truncateToWidth(line, cells, ""));
    },
    invalidate() {
      list.invalidate();
      rule.invalidate();
    },
    handleInput(data: string) {
      if (disposed || finished) return;
      if (matchesKey(data, Key.ctrl("c")) || keybindings.matches(data, "tui.select.cancel")) {
        finish("cancel");
        return;
      }
      // Refresh height/width proof before handling an input racing with terminal resize.
      component.render(tui.terminal.columns ?? lastWidth, false);
      if (keybindings.matches(data, "tui.select.up")) {
        if (!reviewed || (selected === 0 && offset > 0)) offset = Math.max(0, offset - 1);
        else select(selected - 1);
      } else if (keybindings.matches(data, "tui.select.down")) {
        if (!reviewed || (selected === 0 && offset < maximumOffset)) offset = Math.min(maximumOffset, offset + 1);
        else select(selected + 1);
      } else if (keybindings.matches(data, "tui.select.confirm")) {
        const choice = choices[selected] ?? "cancel";
        if (choice !== "approve" || reviewed) finish(choice);
      }
      tui.requestRender();
    },
    handleMouse(event: TuiMouseEvent) {
      if (disposed || finished || event.width !== lastWidth) return undefined;
      component.render(event.width, false);
      if (event.y >= summaryStart && event.y < summaryEnd && event.type === "wheel" && event.wheelDelta) {
        offset = Math.max(0, Math.min(maximumOffset, offset + (event.wheelDelta < 0 ? -1 : 1)));
        select(0);
        tui.requestRender();
        return { handled: true, render: true };
      }
      if (event.y < actionsStart || event.y >= actionsStart + choices.length || event.y >= lastRows) return undefined;
      return list.handleMouse({ ...event, y: event.y - actionsStart, height: choices.length });
    },
    dispose() {
      disposed = true;
      seen.clear();
    },
  };
  return component;
}
