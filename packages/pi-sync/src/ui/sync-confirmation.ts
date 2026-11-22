import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  HorizontalRule,
  hardWrapTerminalDocument,
  renderBoundedFrameLayout,
  sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";

export type SyncConfirmationChoice = "cancel" | "approve" | "details";

/** Kit choice context is clipped on short terminals; this summary must remain reviewable. */
export function createSyncConfirmation(options: {
  title: string;
  lines: readonly string[];
  confirmationLabel: string;
  allowApproval?: boolean;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  complete(choice: SyncConfirmationChoice): void;
}) {
  const { tui, theme, keybindings, allowApproval = true } = options;
  const actions: { value: SyncConfirmationChoice; label: string }[] = [{ value: "cancel", label: "No, cancel" }];
  if (allowApproval)
    actions.push({ value: "approve", label: `Yes, ${sanitizeTerminalText(options.confirmationLabel)}` });
  actions.push({ value: "details", label: "View details" });
  const choices = actions.map((item) => item.value);
  const list = new SelectList(actions, actions.length, {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("muted", text),
  });
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
  let pageSize = 0;
  let actionRows: ReturnType<typeof renderBoundedFrameLayout>["contentRows"] = [];
  let clickedChoice: SyncConfirmationChoice | undefined;
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
  const activate = (choice: SyncConfirmationChoice) => {
    if (choice !== "approve" || reviewed) finish(choice);
  };
  list.onSelect = (item) => {
    if (clickedChoice && item.value === clickedChoice) activate(clickedChoice);
  };
  const scroll = (delta: number) => {
    offset = Math.max(0, Math.min(maximumOffset, offset + delta));
  };
  const terminalRows = () => Math.max(1, Math.floor(tui.terminal.rows) - 3);
  const component = {
    get capturesViewportInput() {
      return list.capturesViewportInput;
    },
    render(width: number, expose = true): string[] {
      const cells = Math.floor(width);
      if (!Number.isFinite(cells) || cells <= 0) {
        reviewed = false;
        actionRows = [];
        return [];
      }
      const rows = terminalRows();
      if (cells !== lastWidth || rows !== lastRows) {
        // Reflow can expose previously unseen rows or hide the selected action.
        // Reset proof and selection rather than carry approval across a resize.
        summary = options.lines.flatMap((line) => hardWrapTerminalDocument(line, cells)).filter((line) => line.trim());
        seen = new Set();
        offset = 0;
        select(0);
        lastWidth = cells;
        lastRows = rows;
      }
      const actions = list.render(cells);
      const framingRows = 5;
      pageSize = Math.max(0, rows - actions.length - framingRows);
      maximumOffset = Math.max(0, summary.length - pageSize);
      offset = Math.min(offset, maximumOffset);
      const visible = summary.slice(offset, offset + pageSize);
      if (expose) for (let index = offset; index < offset + visible.length; index++) seen.add(index);
      // Very small terminals cannot display the summary and all choices together.
      // Keep cancellation available, but never approve a zero-row summary viewport.
      reviewed = pageSize > 0 && seen.size === summary.length;
      // Describe actions without advertising configured keys that can be invalid,
      // aliased, or shadowed by an earlier cancellation/navigation binding.
      const status = theme.fg(
        "muted",
        `Summary ${visible.length ? offset + 1 : 0}-${offset + visible.length}/${summary.length}${reviewed || !allowApproval ? "" : " — page before Yes"}`,
      );
      const layout = renderBoundedFrameLayout({
        width: cells,
        maxRows: rows,
        rule: rule.render(cells)[0] ?? "",
        title: [theme.fg("accent", theme.bold(sanitizeTerminalText(options.title)))],
        context: [...visible.map((line) => theme.fg("text", line)), status],
        content: actions,
        priorityRows: [selected, ...choices.map((_, index) => index)],
        focusedRow: selected,
      });
      actionRows = layout.contentRows;
      return layout.lines;
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
        select(selected - 1);
      } else if (keybindings.matches(data, "tui.select.down")) {
        select(selected + 1);
      } else if (keybindings.matches(data, "tui.select.confirm")) {
        activate(choices[selected] ?? "cancel");
      } else if (keybindings.matches(data, "tui.select.pageUp")) {
        scroll(-pageSize);
      } else if (keybindings.matches(data, "tui.select.pageDown")) {
        scroll(pageSize);
      } else {
        return;
      }
      tui.requestRender();
    },
    handleMouse(event: TuiMouseEvent) {
      if (disposed || finished || event.width !== lastWidth || terminalRows() !== lastRows) return undefined;
      if (
        event.y >= 2 &&
        event.y < 2 + Math.min(pageSize, summary.length) &&
        event.type === "wheel" &&
        event.wheelDelta
      ) {
        scroll(Math.sign(event.wheelDelta));
        return { handled: true, render: true };
      }
      const row = actionRows.find(({ frameIndex }) => frameIndex === event.y);
      if (!row) return undefined;
      clickedChoice = event.type === "click" ? choices[row.contentIndex] : undefined;
      return list.handleMouse({ ...event, y: row.contentIndex, height: choices.length });
    },
    dispose() {
      disposed = true;
      seen.clear();
    },
  };
  return component;
}
