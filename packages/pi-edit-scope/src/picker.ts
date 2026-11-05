import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  type SelectItem,
  SelectList,
  stripTerminalSequences,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { runCustomInteraction } from "@narumitw/pi-tui-kit";
import { displayError, displayFilePath, displayPath, exactRows, scopeFrame } from "./display.js";
import { ScopeInput } from "./input.js";
import type { ScopeTarget } from "./paths.js";
import { type PickerAction, type PickerPanel, pickerKeys } from "./picker-keys.js";
import { MAX_TARGETS } from "./state.js";

type PickerValue =
  | { kind: "selected"; targets: readonly ScopeTarget[] }
  | { kind: "cancelled"; reason: "back" | "close" }
  | { kind: "error"; error: unknown };

export interface ScopePickerOptions {
  cwd: string;
  targets: readonly ScopeTarget[];
  completionLabel: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  discover(signal: AbortSignal): Promise<string[]>;
  resolvePath(raw: string, signal: AbortSignal): Promise<ScopeTarget>;
  validate(
    paths: readonly string[],
    signal: AbortSignal,
    added: readonly ScopeTarget[],
  ): Promise<readonly ScopeTarget[]>;
}

const LIST_ROWS = 10;
function outsideCwd(cwd: string, path: string): boolean {
  const fromCwd = relative(cwd, path);
  return isAbsolute(fromCwd) || fromCwd === ".." || fromCwd.startsWith(`..${sep}`);
}

type Button = { action: PickerAction; label: string; enabled: boolean };
type Pressed = { kind: "file"; id: string } | { kind: "button"; action: PickerAction } | { kind: "cancelled" };

export function showScopePicker(ctx: ExtensionCommandContext, options: ScopePickerOptions) {
  return runCustomInteraction<PickerValue>(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    create: ({ tui, theme, keybindings, signal: ownerSignal, complete }) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([ownerSignal, controller.signal]);
      const placeholder = (text: string) => theme.fg("dim", text);
      const search = new ScopeInput("Search files…", placeholder);
      const pathInput = new ScopeInput("Existing file path…", placeholder);
      const keys = pickerKeys(tui, keybindings);
      const checked = new Set(options.targets.map((target) => target.path));
      const added = new Map<string, ScopeTarget>();
      let panel: PickerPanel = "files";
      let focused = false;
      let fullPaths = false;
      let paths: string[] = [];
      let rows: SelectItem[] = [];
      let list: SelectList;
      let loading = true;
      let validating: "path" | "selection" | undefined;
      let operation: AbortController | undefined;
      let pending = Promise.resolve();
      let disposed = false;
      let closing = false;
      let error = "";
      let notice = "";
      let pressed: Pressed | undefined;
      let mouseLayout:
        | {
            width: number;
            input?: number;
            rows: Map<number, string>;
            buttons: Array<{ row: number; start: number; end: number; action: PickerAction }>;
          }
        | undefined;
      // Absorb the later native click instead of reusing it as a fresh gesture.
      const cancelPress = () => {
        if (pressed) pressed = { kind: "cancelled" };
      };
      const relativePath = (path: string) =>
        outsideCwd(options.cwd, path) ? path : relative(options.cwd, path) || ".";
      const pathLabel = (path: string) => displayFilePath(fullPaths ? path : relativePath(path));
      const syncFocus = () => {
        search.input.focused = focused && panel === "files";
        pathInput.input.focused = focused && panel === "path";
      };
      const current = () => {
        if (disposed || closing || signal.aborted) return false;
        if (options.isCurrent()) return true;
        closing = true;
        complete({ kind: "cancelled", reason: "close" });
        controller.abort();
        return false;
      };
      const close = (value: PickerValue) => {
        if (!current()) return;
        closing = true;
        complete(value);
        controller.abort();
      };
      const rebuild = (selectedId = list?.getSelectedItem()?.value) => {
        cancelPress();
        // Escape display identities before fuzzy matching; raw absolute IDs stay payloads.
        const query = displayPath(search.input.getValue()).slice(1, -1);
        rows = fuzzyFilter(paths, query, (path) => displayPath(relativePath(path)).slice(1, -1)).map((path) => ({
          value: path,
          label: `${checked.has(path) ? "[x]" : "[ ]"} ${outsideCwd(options.cwd, path) ? "(outside) " : ""}${pathLabel(path)}`,
        }));
        list = new SelectList(rows, LIST_ROWS, {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        list.setSelectedIndex(
          Math.max(
            0,
            rows.findIndex((row) => row.value === selectedId),
          ),
        );
      };
      const runValidation = (kind: "path" | "selection", work: (operationSignal: AbortSignal) => Promise<void>) => {
        const owned = new AbortController();
        const operationSignal = AbortSignal.any([signal, owned.signal]);
        operation = owned;
        validating = kind;
        error = "";
        pending = (async () => {
          try {
            await work(operationSignal);
          } catch (failure) {
            if (current() && !operationSignal.aborted) error = displayError(failure);
          } finally {
            if (operation === owned) {
              operation = undefined;
              validating = undefined;
            }
            if (current()) tui.requestRender();
          }
        })();
      };
      const apply = () => {
        if (!current() || loading || validating) return;
        const selectedPaths = paths.filter((path) => checked.has(path));
        if (!selectedPaths.length) {
          error = "Select at least one file first.";
          return;
        }
        runValidation("selection", async (operationSignal) => {
          const targets = await options.validate(selectedPaths, operationSignal, [...added.values()]);
          if (current() && !operationSignal.aborted) close({ kind: "selected", targets });
        });
      };
      const addPath = () => {
        if (!current() || loading || validating) return;
        const raw = pathInput.input.getValue();
        if (!raw.length) {
          error = "Enter an existing file path.";
          return;
        }
        runValidation("path", async (operationSignal) => {
          const target = await options.resolvePath(raw, operationSignal);
          if (!current() || operationSignal.aborted) return;
          if (!added.has(target.path) && added.size >= MAX_TARGETS) {
            throw new Error(`Add no more than ${MAX_TARGETS} distinct paths in one picker.`);
          }
          const previous = list.getSelectedItem()?.value;
          added.set(target.path, { path: target.path, canonical: target.canonical });
          if (!paths.includes(target.path)) paths.push(target.path);
          checked.add(target.path);
          pathInput.input.setValue("");
          panel = "files";
          syncFocus();
          rebuild(target.path);
          if (!rows.some((row) => row.value === target.path))
            list.setSelectedIndex(
              Math.max(
                0,
                rows.findIndex((row) => row.value === previous),
              ),
            );
          notice = `Added ${pathLabel(target.path)}`;
        });
      };
      const mark = (id: string, move = 0) => {
        if (!current() || loading || validating) return;
        const index = rows.findIndex((row) => row.value === id);
        if (index < 0) return;
        if (checked.has(id)) checked.delete(id);
        else checked.add(id);
        error = "";
        notice = "";
        // Marking stops at the result boundaries; ordinary arrow navigation still wraps.
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + move))]?.value;
        rebuild(next);
      };
      const perform = (command: PickerAction) => {
        if (command === "close") close({ kind: "cancelled", reason: "close" });
        else if (command === "cancel") {
          if (panel === "files") close({ kind: "cancelled", reason: "back" });
          else {
            operation?.abort();
            panel = "files";
            error = "";
            syncFocus();
          }
        } else if (loading || validating) return;
        else if (command === "apply") apply();
        else if (command === "submit") addPath();
        else if (command === "add") {
          panel = "path";
          error = "";
          notice = "";
          cancelPress();
          syncFocus();
        } else if (command === "paths") {
          fullPaths = !fullPaths;
          rebuild();
        } else if (command === "mark" || command === "markUp") {
          const id = list.getSelectedItem()?.value;
          if (id) mark(id, command === "mark" ? 1 : -1);
        } else if (command === "up" || command === "down" || command === "pageUp" || command === "pageDown") {
          const index = rows.findIndex((row) => row.value === list.getSelectedItem()?.value);
          if (index < 0) return;
          if (command === "pageUp" || command === "pageDown")
            list.setSelectedIndex(index + (command === "pageUp" ? -LIST_ROWS : LIST_ROWS));
          else list.setSelectedIndex((index + (command === "up" ? -1 : 1) + rows.length) % rows.length);
        }
      };
      const handleInput = (data: string): void => {
        if (!current()) return;
        cancelPress();
        // A fragmented paste keeps its original input owner across async panel changes.
        const activeInput = search.isPasting
          ? search
          : pathInput.isPasting
            ? pathInput
            : panel === "files"
              ? search
              : pathInput;
        const previous = activeInput.input.getValue();
        let remaining: string | undefined;
        activeInput.handleInput(
          data,
          (data) => {
            const command = keys.action(data, panel);
            if (command === "cancel" || command === "close") {
              perform(command);
              return true;
            }
            if (validating) return true;
            if (!command || command === "input") return false;
            perform(command);
            return true;
          },
          !validating,
          (tail) => {
            remaining = tail;
          },
        );
        if (!current()) return;
        if (activeInput.input.getValue() !== previous) {
          error = "";
          notice = "";
          if (activeInput === search && !loading) rebuild("");
        }
        // Publish the pasted query before dispatching list actions from its tail.
        if (remaining) handleInput(remaining);
        if (current()) tui.requestRender();
      };
      rebuild();
      pending = (async () => {
        try {
          const discovered = await options.discover(signal);
          if (!current()) return;
          paths = [...new Set([...options.targets.map((target) => target.path), ...discovered])];
          loading = false;
          rebuild();
          tui.requestRender();
        } catch (failure) {
          if (current()) close({ kind: "error", error: failure });
        }
      })();
      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          syncFocus();
        },
        render(width: number) {
          const safeWidth = Math.max(1, width);
          const activeInput = panel === "files" ? search : pathInput;
          const pasting = search.isPasting || pathInput.isPasting;
          const busy = loading || validating !== undefined || pasting;
          const selectedIndex = rows.findIndex((row) => row.value === list.getSelectedItem()?.value);
          const start = Math.max(0, Math.min(selectedIndex - Math.floor(LIST_ROWS / 2), rows.length - LIST_ROWS));
          const activeRow = rows[selectedIndex];
          const content = [...activeInput.render(safeWidth)];
          const filesStart = content.length + 1;
          let focusedRow = 0;
          if (panel === "files") {
            const listRows = loading
              ? [theme.fg("dim", "Scanning files…")]
              : rows.length
                ? list.render(safeWidth)
                : [theme.fg("dim", "No matching files")];
            content.push("", ...listRows);
            focusedRow = rows.length && !loading ? filesStart + selectedIndex - start : 0;
            const target =
              added.get(activeRow?.value ?? "") ?? options.targets.find((target) => target.path === activeRow?.value);
            const preview = [
              ...(activeRow && !stripTerminalSequences(listRows[selectedIndex - start] ?? "").includes(activeRow.label)
                ? [`Path: ${pathLabel(activeRow.value)}`]
                : []),
              ...(target && (outsideCwd(options.cwd, target.path) || outsideCwd(options.cwd, target.canonical))
                ? ["Outside the current directory."]
                : []),
              ...(target && target.path !== target.canonical
                ? [`Canonical target: ${pathLabel(target.canonical)}`]
                : []),
            ];
            content.push(
              ...preview.flatMap((line) => exactRows(line, safeWidth).map((part) => theme.fg("muted", part))),
            );
          } else if (pathInput.input.getValue()) {
            content.push(
              ...exactRows(`Path: ${displayPath(pathInput.input.getValue())}`, safeWidth).map((line) =>
                theme.fg("muted", line),
              ),
            );
          }
          if (notice) content.push(...exactRows(notice, safeWidth).map((line) => theme.fg("muted", line)));
          if (error) content.push(...exactRows(error, safeWidth).map((line) => theme.fg("error", line)));
          if (validating)
            content.push(
              theme.fg(
                "dim",
                operation?.signal.aborted
                  ? "Finishing file check…"
                  : validating === "path"
                    ? "Checking file…"
                    : "Checking selected files…",
              ),
            );
          const pathModeLabel = fullPaths ? "Relative paths" : "Full paths";
          const buttons: Button[] =
            panel === "files"
              ? [
                  { action: "apply", label: options.completionLabel, enabled: !busy && checked.size > 0 },
                  { action: "add", label: pasting ? "Add file…" : keys.label("add", "Add file…"), enabled: !busy },
                  {
                    action: "paths",
                    label: pasting ? pathModeLabel : keys.label("paths", pathModeLabel),
                    enabled: !busy,
                  },
                ]
              : [
                  { action: "cancel", label: "Back", enabled: !pasting },
                  { action: "submit", label: "Add file", enabled: !busy && pathInput.input.getValue().length > 0 },
                ];
          let column = 0;
          const spans = buttons.map((button) => {
            const text = `[ ${button.label} ]`;
            const span = {
              start: column,
              end: column + visibleWidth(text),
              action: button.action,
              enabled: button.enabled,
            };
            column = span.end + 2;
            return { ...span, text: theme.fg(button.enabled ? "muted" : "dim", text) };
          });
          const buttonRow = content.length;
          content.push(spans.map((span) => span.text).join("  "));
          const frame = scopeFrame(
            tui,
            theme,
            width,
            panel === "files" ? "Select files" : "Add existing file",
            [`Cwd: ${displayFilePath(options.cwd)}`],
            content,
            [focusedRow, 0, buttonRow],
            focusedRow,
            [pasting ? `${checked.size} selected • Pasting…` : keys.hints(panel, checked.size, busy)],
          );
          const buttonFrameRow = frame.contentRows.find((row) => row.contentIndex === buttonRow)?.frameIndex;
          mouseLayout = {
            width,
            input: frame.contentRows.find((row) => row.contentIndex === 0)?.frameIndex,
            rows: new Map(
              panel === "files"
                ? frame.contentRows.flatMap((row) => {
                    const native = row.contentIndex - filesStart;
                    const id = rows[start + native]?.value;
                    return native >= 0 && native < Math.min(LIST_ROWS, rows.length) && id ? [[row.frameIndex, id]] : [];
                  })
                : [],
            ),
            buttons:
              buttonFrameRow === undefined
                ? []
                : spans
                    .filter((span) => span.enabled && span.end <= width)
                    .map((span) => ({ row: buttonFrameRow, start: span.start, end: span.end, action: span.action })),
          };
          return frame.lines;
        },
        handleInput,
        handleMouse(event: TuiMouseEvent) {
          if (
            !current() ||
            !mouseLayout ||
            event.width !== mouseLayout.width ||
            search.isPasting ||
            pathInput.isPasting
          )
            return;
          // Native click follows the original press even if a render moves the rows.
          if (event.type === "click" && event.button === "left" && pressed) {
            const target = pressed;
            pressed = undefined;
            if (target.kind === "file") mark(target.id);
            else if (target.kind === "button") perform(target.action);
            return { handled: true, render: target.kind !== "cancelled" };
          }
          if (event.type === "press" && event.button === "left") pressed = undefined;
          const button = mouseLayout.buttons.find(
            (button) => button.row === event.y && event.x >= button.start && event.x < button.end,
          );
          if (button && event.button === "left") {
            if (event.type === "press") pressed = { kind: "button", action: button.action };
            else if (event.type === "click") perform(button.action);
            else return;
            return { handled: true, render: true, focus: event.type === "press" };
          }
          if (loading || validating) return;
          if (event.y === mouseLayout.input) {
            const result = (panel === "files" ? search : pathInput).handleMouse({ ...event, y: 0, height: 1 });
            // Input edits the caret on press only; its later click must not hit a moved button.
            if (event.type === "press" && result?.handled) pressed = { kind: "cancelled" };
            return result;
          }
          const id = mouseLayout.rows.get(event.y);
          if (!id) return;
          if (event.type === "wheel" && event.wheelDelta) {
            cancelPress();
            const selected = rows.findIndex((row) => row.value === list.getSelectedItem()?.value);
            list.setSelectedIndex(Math.max(0, Math.min(rows.length - 1, selected + (event.wheelDelta < 0 ? -1 : 1))));
          } else if (event.type === "press" && event.button === "left") {
            pressed = { kind: "file", id };
            list.setSelectedIndex(rows.findIndex((row) => row.value === id));
          } else if (event.type === "click" && event.button === "left") mark(id);
          else return;
          return { handled: true, render: true, focus: event.type === "press" };
        },
        invalidate() {
          cancelPress();
          mouseLayout = undefined;
          search.input.invalidate();
          pathInput.input.invalidate();
          list.invalidate();
        },
        waitForPending: () => pending,
        dispose() {
          if (disposed) return;
          disposed = true;
          pressed = undefined;
          controller.abort();
        },
      };
    },
  });
}
