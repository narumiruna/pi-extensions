import { type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeyId,
  Markdown,
  matchesKey,
  type OverlayHandle,
  type TUI,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import { type FloatingBounds, FloatingFrame } from "@narumitw/pi-tui-kit/floating-frame";
import { createInteractionInputGuard } from "./interaction-coordinator.js";
import type { PaneDocument } from "./plan-pane.js";
import { floatingAdjustmentKey } from "./plan-pane-shortcut.js";

const MIN_SIZE = { columns: 28, rows: 6 };
const MAIN_INPUT_ROWS = 4;
const DIRECTIONS = [
  ["left", -1, 0],
  ["right", 1, 0],
  ["up", 0, -1],
  ["down", 0, 1],
] as const;

export interface FloatingReadingPosition {
  bounds?: FloatingBounds;
  top: number;
}

export interface FloatingAdjustment {
  editor: Component;
  input: string;
}

function focusedComponent(tui: TUI) {
  const screen = tui as TUI & Partial<Pick<TuiMainScreen, "getFocusedComponent">>;
  if (typeof screen.getFocusedComponent === "function") return screen.getFocusedComponent();
}

function mounted(tui: TUI, component: Component) {
  return tui.children.some(
    (root) =>
      root === component || ("children" in root && Array.isArray(root.children) && root.children.includes(component)),
  );
}

function mainEditor(tui: TUI) {
  const focused = focusedComponent(tui);
  if (
    focused &&
    mounted(tui, focused) &&
    "getText" in focused &&
    typeof focused.getText === "function" &&
    "setText" in focused &&
    typeof focused.setText === "function" &&
    "onSubmit" in focused &&
    typeof focused.onSubmit === "function" &&
    typeof focused.handleInput === "function"
  ) {
    return focused;
  }
}

export function createFloatingPlanPane(
  ui: ExtensionContext["ui"],
  initialDocument: PaneDocument,
  reading: FloatingReadingPosition,
  planModeShortcut: () => string | undefined,
  onUnsupported: () => void,
) {
  let document = initialDocument;
  let top = reading.top;
  let bounds = reading.bounds;
  let closeNative: (() => void) | undefined;
  let handle: OverlayHandle | undefined;
  let frame: FloatingFrame | undefined;
  let host: TUI | undefined;
  let renderer: readonly Component[] | undefined;
  let mountFocus: Component | null | undefined;
  let returnFocus: Component | undefined;
  let markdown: Markdown | undefined;
  let closed = false;
  let opened = false;
  let painted: PaneDocument | undefined;
  let releaseQueued = false;
  let adjustmentKey: (() => ReturnType<typeof floatingAdjustmentKey>) | undefined;

  const isCurrent = () => !closed && host !== undefined && host.children === renderer;
  const fits = (columns: number, rows: number) =>
    columns >= MIN_SIZE.columns && rows >= MIN_SIZE.rows + MAIN_INPUT_ROWS;
  const visible = () => isCurrent() && handle?.getBounds() !== undefined;

  function enterAdjustment({ editor, input }: FloatingAdjustment): boolean {
    if (!isCurrent() || !host || !handle || mainEditor(host) !== editor || !canAdjustFrom(editor)) return false;
    const key = adjustmentKey?.();
    if (!key || !matchesKey(input, key) || !fits(host.terminal.columns, host.terminal.rows)) return false;
    handle.focus();
    if (!handle.isFocused()) return false;
    returnFocus = editor;
    return true;
  }

  function leaveAdjustment() {
    const target = returnFocus;
    returnFocus = undefined;
    if (!target || !handle || !host || host.children !== renderer) return;
    if (mounted(host, target)) handle.unfocus({ target });
    else if (handle.isFocused()) handle.unfocus({ target: null });
  }

  function close() {
    if (!closed) {
      leaveAdjustment();
      closed = true;
      const done = closeNative;
      closeNative = undefined;
      done?.();
      handle = undefined;
    }
    return bounds ? { bounds, top } : { top };
  }

  return {
    get disposed() {
      return closed;
    },
    open(pendingAdjustment?: FloatingAdjustment) {
      if (closed || opened) return;
      opened = true;
      void ui
        .custom<void>(
          (tui, theme, keybindings, done) => {
            if (closed) {
              done(undefined);
              return { render: () => [], invalidate() {} };
            }
            host = tui;
            renderer = tui.children;
            closeNative = () => done(undefined);
            adjustmentKey = () =>
              floatingAdjustmentKey(keybindings.getResolvedBindings(), tui.mode, planModeShortcut());
            const permitsInput = createInteractionInputGuard(true);
            const readMarkdown = (columns: number) => {
              markdown ??= new Markdown(document.text, 0, 0, getMarkdownTheme());
              return markdown.render(columns);
            };
            const scrollBy = (delta: number) => {
              const { columns, rows } = window.viewport;
              const next = Math.min(Math.max(0, readMarkdown(columns).length - rows), Math.max(0, top + delta));
              if (next === top) return false;
              top = next;
              return true;
            };
            const window = new FloatingFrame({
              getTerminalSize: () => ({ columns: tui.terminal.columns, rows: tui.terminal.rows - MAIN_INPUT_ROWS }),
              initialBounds: ({ columns, rows }) => {
                if (reading.bounds) return reading.bounds;
                const width = Math.min(56, Math.max(MIN_SIZE.columns, Math.round(columns * 0.46)));
                return { col: columns - width - 1, row: 1, width, height: Math.min(12, Math.round(rows * 0.75)) };
              },
              minSize: MIN_SIZE,
              requestRender() {
                if (!isCurrent()) return;
                if (fits(tui.terminal.columns, tui.terminal.rows)) bounds = window.bounds;
                tui.requestRender();
              },
              styleBorder: (text) => theme.fg(window.focused ? "border" : "borderMuted", text),
              styleTitle: (text) => text,
              title(columns) {
                const title = document.completed ? "Plan · Ready" : "Plan draft";
                const heading = theme.bold(theme.fg("accent", ` ${title}`));
                const editor = mainEditor(tui);
                const key = !window.focused && editor && canAdjustFrom(editor) ? adjustmentKey?.() : undefined;
                const hint = window.focused ? "Adjust" : key ? `${key.toUpperCase()} adjust` : "";
                return hint && columns >= title.length + hint.length + 4
                  ? `${heading}${theme.fg("muted", ` · ${hint}`)}`
                  : heading;
              },
              overlay: {
                nonCapturing: true,
                visible(columns, rows) {
                  if (isCurrent() && fits(columns, rows)) return true;
                  painted = undefined;
                  if (returnFocus && !releaseQueued) {
                    releaseQueued = true;
                    queueMicrotask(() => {
                      releaseQueued = false;
                      if (isCurrent() && !fits(tui.terminal.columns, tui.terminal.rows)) leaveAdjustment();
                    });
                  }
                  return false;
                },
              },
              body: {
                render({ columns, rows }) {
                  const lines = readMarkdown(columns);
                  top = Math.min(top, Math.max(0, lines.length - rows));
                  if (painted !== document) {
                    painted = document;
                    bounds ??= window.bounds;
                    queueMicrotask(() => {
                      if (isCurrent()) tui.requestRender();
                    });
                  }
                  return lines.slice(top, top + rows);
                },
                invalidate() {
                  markdown = undefined;
                },
                handleInput(data) {
                  if (!isCurrent() || !permitsInput(data) || !handle?.isFocused()) return;
                  if (
                    matchesKey(data, "ctrl+c") ||
                    matchesKey(data, "escape") ||
                    keybindings.matches(data, "app.interrupt")
                  ) {
                    leaveAdjustment();
                    return;
                  }
                  if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
                    if (scrollBy((matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, window.viewport.rows - 1)))
                      tui.requestRender();
                    return;
                  }
                  for (const [key, dx, dy] of DIRECTIONS) {
                    if (matchesKey(data, key)) window.move(dx, dy);
                    else if (matchesKey(data, `shift+${key}` as KeyId)) window.resize(dx, dy);
                    else continue;
                    break;
                  }
                },
                handleMouse(event) {
                  if (event.type === "wheel") return { handled: true, render: scrollBy(event.wheelDelta ?? 0) };
                },
              },
            });
            frame = window;
            const component: Component & { focused: boolean; dispose(): void } = {
              get focused() {
                return window.focused;
              },
              set focused(value) {
                window.focused = value;
              },
              render(width) {
                return window.render(width);
              },
              invalidate() {
                window.invalidate();
              },
              handleInput(data) {
                window.handleInput(data);
              },
              handleMouse(event) {
                if (isCurrent()) return window.handleMouse(event);
              },
              dispose() {
                close();
              },
            };
            return component;
          },
          {
            overlay: true,
            overlayOptions: () => frame?.overlayOptions ?? { nonCapturing: true, visible: () => false },
            onHandle(nativeHandle) {
              if (!isCurrent()) return;
              if (
                typeof nativeHandle.getBounds !== "function" ||
                typeof nativeHandle.focus !== "function" ||
                typeof nativeHandle.unfocus !== "function" ||
                typeof nativeHandle.isFocused !== "function"
              ) {
                close();
                onUnsupported();
                return;
              }
              handle = nativeHandle;
              if (host) mountFocus = focusedComponent(host);
              if (pendingAdjustment && pendingAdjustment.editor === mountFocus) enterAdjustment(pendingAdjustment);
            },
          },
        )
        .then(close, close);
    },
    close,
    setDocument(next: PaneDocument) {
      if (next.raw === document.raw && next.completed === document.completed) return;
      document = next;
      frame?.invalidate();
      if (isCurrent()) host?.requestRender();
    },
    handleInput(
      data: string,
      canToggle: boolean,
      toggle: () => void,
      remount: (adjustment: FloatingAdjustment) => void,
    ) {
      if (!isCurrent() || !host || !handle) return false;
      if (handle.isFocused() && !fits(host.terminal.columns, host.terminal.rows)) leaveAdjustment();
      if (canToggle && handle.isFocused() && matchesKey(data, "f4")) {
        toggle();
        return true;
      }
      const editor = mainEditor(host);
      const key = editor && canAdjustFrom(editor) ? adjustmentKey?.() : undefined;
      if (!editor || !key || !matchesKey(data, key) || !visible()) return false;
      const adjustment = { editor, input: data };
      if (mountFocus !== editor) {
        remount(adjustment);
        return true;
      }
      return enterAdjustment(adjustment);
    },
    showsCompletedPlan(plan: string) {
      return (
        document.completed &&
        document.raw === plan &&
        painted === document &&
        visible() &&
        (handle?.isFocused() || (host !== undefined && mainEditor(host) !== undefined))
      );
    },
  };
}

function canAdjustFrom(editor: Component) {
  return !(
    "isShowingAutocomplete" in editor &&
    typeof editor.isShowingAutocomplete === "function" &&
    editor.isShowingAutocomplete()
  );
}

export type FloatingPlanPane = ReturnType<typeof createFloatingPlanPane>;
