import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type SelectItem, SelectList, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { runCustomInteraction } from "@narumitw/pi-tui-kit";
import { displayError, displayPath, exactRows, scopeFrame } from "./display.ts";
import { ScopeInput } from "./input.ts";
import type { ScopeTarget } from "./paths.ts";
import { MAX_TARGETS } from "./state.ts";

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

function isPathInput(raw: string): boolean {
  return raw.includes("/") || (process.platform === "win32" && raw.includes("\\"));
}

function outsideCwd(cwd: string, path: string): boolean {
  const fromCwd = relative(cwd, path);
  return isAbsolute(fromCwd) || fromCwd === ".." || fromCwd.startsWith(`..${sep}`);
}

export function showScopePicker(ctx: ExtensionCommandContext, options: ScopePickerOptions) {
  return runCustomInteraction<PickerValue>(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    create: ({ tui, theme, keybindings, signal: ownerSignal, complete }) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([ownerSignal, controller.signal]);
      const search = new ScopeInput();
      const checked = new Set(options.targets.map((target) => target.path));
      const added = new Map<string, ScopeTarget>();
      let paths: string[] = [];
      let rows: SelectItem[] = [];
      let list: SelectList;
      let loading = true;
      let validating: "path" | "selection" | undefined;
      let pending = Promise.resolve();
      let disposed = false;
      let closing = false;
      let error = "";
      let doneId = "__scope_apply__";
      let addId = "__scope_add_path__";
      let mousePressedId: string | undefined;
      let mouseLayout: { width: number; input?: number; rows: Map<number, number> } | undefined;
      const current = () => {
        if (disposed || closing || signal.aborted) return false;
        if (options.isCurrent()) return true;
        closing = true;
        // Calling the public completion boundary with stale ownership makes
        // runCustomInteraction settle as stale and drain this component.
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
        mousePressedId = undefined;
        const raw = search.input.getValue();
        const query = displayPath(raw).slice(1, -1).toLowerCase();
        const matching = paths.filter((path) => displayPath(path).toLowerCase().includes(query));
        const pathInput = isPathInput(raw);
        // Resolve path-shaped input explicitly before exposing completion. The
        // Add action precedes substring matches so an external absolute path
        // cannot accidentally check a similarly named cwd file instead.
        rows = [
          ...(pathInput ? [{ value: addId, label: `Add file: ${displayPath(raw)}` }] : []),
          ...matching.map((path) => ({
            value: path,
            label: `${checked.has(path) ? "[x]" : "[ ]"} ${displayPath(path)}`,
          })),
        ];
        // Ordinary unmatched search (especially a literal Space) cannot apply.
        if (!pathInput && (!query || matching.length > 0)) rows.push({ value: doneId, label: options.completionLabel });
        list = new SelectList(rows, 8, {
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
        list.onSelect = (item) => activate(item.value);
      };
      const runValidation = (kind: "path" | "selection", work: () => Promise<void>) => {
        validating = kind;
        error = "";
        pending = (async () => {
          try {
            await work();
          } catch (failure) {
            if (current()) error = displayError(failure);
          } finally {
            validating = undefined;
            if (current()) tui.requestRender();
          }
        })();
      };
      const activate = (id: string) => {
        if (!current() || loading || validating) return;
        if (id === addId) {
          const draft = search.input.getValue();
          runValidation("path", async () => {
            const target = await options.resolvePath(draft, signal);
            if (!current()) return;
            if (!added.has(target.path) && added.size >= MAX_TARGETS) {
              throw new Error(`Add no more than ${MAX_TARGETS} distinct paths in one picker.`);
            }
            added.set(target.path, { path: target.path, canonical: target.canonical });
            if (!paths.includes(target.path)) paths.push(target.path);
            checked.add(target.path);
            search.input.setValue("");
            rebuild(target.path);
          });
          return;
        }
        if (id !== doneId) {
          if (checked.has(id)) checked.delete(id);
          else checked.add(id);
          error = "";
          rebuild(id);
          return;
        }
        const selectedPaths = paths.filter((path) => checked.has(path));
        if (selectedPaths.length === 0) {
          close({ kind: "selected", targets: [] });
          return;
        }
        runValidation("selection", async () => {
          const targets = await options.validate(selectedPaths, signal, [...added.values()]);
          if (current()) close({ kind: "selected", targets });
        });
      };
      rebuild();
      pending = (async () => {
        try {
          const discovered = await options.discover(signal);
          if (!current()) return;
          paths = [...new Set([...options.targets.map((target) => target.path), ...discovered])];
          while (paths.includes(doneId)) doneId = `_${doneId}`;
          while (paths.includes(addId) || addId === doneId) addId = `_${addId}`;
          loading = false;
          rebuild(isPathInput(search.input.getValue()) ? addId : paths[0]);
          tui.requestRender();
        } catch (failure) {
          if (current()) close({ kind: "error", error: failure });
        }
      })();
      return {
        get focused() {
          return search.input.focused;
        },
        set focused(value: boolean) {
          search.input.focused = value;
        },
        render(width: number) {
          const safeWidth = Math.max(1, width);
          const listRows = loading
            ? [theme.fg("dim", "Scanning files…")]
            : rows.length
              ? list.render(safeWidth)
              : [theme.fg("dim", "No matching files; edit search.")];
          const activeId = list.getSelectedItem()?.value;
          const selectedIndex = rows.findIndex((row) => row.value === activeId);
          // SelectList centers an eight-row viewport. Map clipped frame rows
          // back to those native rows for pointer input.
          const start = Math.max(0, Math.min(selectedIndex - 4, rows.length - 8));
          const focusedRow = 2 + Math.max(0, selectedIndex - start);
          const target = added.get(activeId ?? "") ?? options.targets.find((item) => item.path === activeId);
          const previewLines =
            activeId === addId
              ? [`Existing file path: ${displayPath(search.input.getValue())}`]
              : activeId && activeId !== doneId
                ? [
                    `Path: ${displayPath(activeId)}`,
                    ...(target && (outsideCwd(options.cwd, target.path) || outsideCwd(options.cwd, target.canonical))
                      ? ["Outside the current directory."]
                      : []),
                    ...(target && target.path !== target.canonical
                      ? [`Canonical target: ${displayPath(target.canonical)}`]
                      : []),
                  ]
                : [];
          const preview = previewLines.flatMap((line) =>
            exactRows(line, safeWidth).map((part) => theme.fg("muted", part)),
          );
          const content = [
            ...search.render(safeWidth),
            "",
            ...listRows,
            ...preview,
            ...(error ? exactRows(error, safeWidth).map((line) => theme.fg("error", line)) : []),
            ...(validating
              ? [theme.fg("dim", validating === "path" ? "Checking file path…" : "Checking selected files…")]
              : []),
          ];
          const frame = scopeFrame(
            tui,
            theme,
            width,
            "Select allowed files",
            [
              `Cwd: ${displayPath(options.cwd)}`,
              `${checked.size} selected. Confirm a file to toggle; confirm the completion row to finish.`,
              "Search, or enter a full or ~/ path and confirm Add file to check an existing file.",
            ],
            content,
            loading || rows.length === 0 ? [0] : [focusedRow, 0],
            focusedRow,
          );
          mouseLayout = {
            width,
            input: frame.contentRows.find((row) => row.contentIndex === 0)?.frameIndex,
            rows: new Map(
              frame.contentRows.flatMap((row) => {
                const native = row.contentIndex - 2;
                return native >= 0 && native < Math.min(8, rows.length) ? [[row.frameIndex, start + native]] : [];
              }),
            ),
          };
          return frame.lines;
        },
        handleInput(data: string) {
          if (!current()) return;
          mousePressedId = undefined;
          const previous = search.input.getValue();
          const action = (key: string) => {
            if (matchesKey(key, "ctrl+c")) close({ kind: "cancelled", reason: "close" });
            else if (keybindings.matches(key, "tui.select.cancel")) close({ kind: "cancelled", reason: "back" });
            else if (validating) return true;
            else if (keybindings.matches(key, "tui.select.up") || keybindings.matches(key, "tui.select.down")) {
              if (!loading) list.handleInput(key);
            } else if (
              keybindings.matches(key, "tui.select.pageUp") ||
              keybindings.matches(key, "tui.select.pageDown")
            ) {
              if (!loading) {
                const index = rows.findIndex((row) => row.value === list.getSelectedItem()?.value);
                list.setSelectedIndex(index + (keybindings.matches(key, "tui.select.pageUp") ? -8 : 8));
              }
            } else if (keybindings.matches(key, "tui.select.confirm")) {
              if (!loading) list.handleInput(key);
            } else return false;
            return true;
          };
          search.handleInput(data, action, !validating);
          if (search.input.getValue() !== previous && !loading)
            rebuild(isPathInput(search.input.getValue()) ? addId : undefined);
          tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent) {
          if (!current() || loading || validating || !mouseLayout || event.width !== mouseLayout.width) return;
          if (event.y === mouseLayout.input) return search.input.handleMouse({ ...event, y: 0, height: 1 });
          const index = mouseLayout.rows.get(event.y);
          if (index === undefined) return;
          if (event.type === "wheel" && event.wheelDelta) {
            mousePressedId = undefined;
            const selected = rows.findIndex((row) => row.value === list.getSelectedItem()?.value);
            list.setSelectedIndex(Math.max(0, Math.min(rows.length - 1, selected + (event.wheelDelta < 0 ? -1 : 1))));
          } else if (event.button === "left" && event.type === "press") {
            mousePressedId = rows[index]?.value;
            list.setSelectedIndex(index);
          } else if (event.button === "left" && event.type === "click") {
            // Press can recenter SelectList before click reaches the same screen row.
            // Activate the pressed raw ID, not the row that moved under the pointer.
            const id = mousePressedId ?? rows[index]?.value;
            mousePressedId = undefined;
            const selected = rows.findIndex((row) => row.value === id);
            if (selected < 0 || !id) return;
            list.setSelectedIndex(selected);
            activate(id);
          } else return;
          return { handled: true, render: true };
        },
        invalidate() {
          mousePressedId = undefined;
          mouseLayout = undefined;
          search.input.invalidate();
          list.invalidate();
        },
        waitForPending: () => pending,
        dispose() {
          if (disposed) return;
          disposed = true;
          mousePressedId = undefined;
          controller.abort();
        },
      };
    },
  });
}
