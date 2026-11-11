import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "./editor-status-widget.js";
import { sanitizeTerminalText } from "./terminal-text.js";

export interface EditorStatusPublisher<T> {
  publish(snapshot: T | undefined): void;
  /** Set the named TUI frame's disclosure from an owner keyboard action. */
  setCollapsed(collapsed: boolean): boolean;
  dispose(): void;
}

export interface EditorStatusPublisherOptions<T> {
  key: string;
  /** Replace the supplied frame's first divider with a named collapse control in TUI mode. */
  name?: string;
  context: Pick<ExtensionContext, "mode" | "hasUI" | "ui">;
  isCurrent(): boolean;
  render(snapshot: T, theme: Theme, width: number, rows: number): readonly string[];
}

interface Mount {
  component?: Component & { dispose(): void };
  tui?: TUI;
}

/**
 * Publish complete, caller-owned immutable display snapshots under one owned key.
 * The renderer supplies all lines, including the EditorStatusWidget frame.
 * Dispose before transferring the key to another owner; there is no shared registry.
 */
export function createEditorStatusPublisher<T>(options: EditorStatusPublisherOptions<T>): EditorStatusPublisher<T> {
  // Read context properties only while this owner is valid. Headless publishers
  // do not retain a UI object (headless sessions can share the same no-op UI).
  const { key, isCurrent, render } = options;
  if (!isCurrent()) return { publish() {}, setCollapsed: () => false, dispose() {} };
  const { mode, hasUI } = options.context;
  if (!hasUI || (mode !== "tui" && mode !== "rpc")) return { publish() {}, setCollapsed: () => false, dispose() {} };
  const ui = options.context.ui;
  const name = sanitizeTerminalText(options.name ?? "").trim();
  const state = { collapsed: false };
  let disposed = false;
  let latest: T | undefined;
  let mount: Mount | undefined;
  let rpcVisible = false;
  let needsClear = false;
  let writeVersion = 0;
  const current = () => !disposed && isCurrent();

  const clear = () => {
    mount = undefined;
    rpcVisible = false;
    if (!needsClear) return;
    if (!isCurrent()) {
      needsClear = false;
      return;
    }
    const version = writeVersion;
    ui.setWidget(key, undefined);
    // Retain cleanup ownership after failure, but not after a reentrant new write.
    if (writeVersion === version) needsClear = false;
  };
  const fail = (error: unknown): never => {
    try {
      clear();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Editor status publication and cleanup failed");
    }
    throw error;
  };

  return {
    publish(snapshot) {
      if (!current()) return;
      const unchanged = Object.is(latest, snapshot);
      latest = snapshot;
      if (snapshot === undefined) {
        clear();
        return;
      }
      if (mode === "rpc") {
        if (unchanged && rpcVisible) return;
        try {
          const lines = [...render(snapshot, ui.theme, 80, 36)];
          if (!current()) return;
          rpcVisible = true;
          needsClear = true;
          writeVersion++;
          ui.setWidget(key, lines, { placement: "aboveEditor" });
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (mount) {
        if (!unchanged) {
          mount.component?.invalidate();
          mount.tui?.requestRender();
        }
        return;
      }

      const token: Mount = {};
      mount = token;
      needsClear = true;
      const attempt = ++writeVersion;
      try {
        ui.setWidget(
          key,
          (tui) => {
            token.tui = tui;
            let lines: readonly string[] = [];
            const frame = name
              ? new EditorStatusWidget({
                  name,
                  state,
                  get theme() {
                    return ui.theme;
                  },
                  renderBody: () => lines.slice(1),
                })
              : undefined;
            const component = {
              render(width: number): string[] {
                frame?.invalidate();
                if (!current() || mount !== token || latest === undefined) return [];
                // Render the latest snapshot even while collapsed so the owner's
                // visibility and row-budget decisions remain authoritative.
                lines = render(latest, ui.theme, width, tui.terminal.rows);
                if (!current() || mount !== token || latest === undefined) return [];
                return frame && lines.length > 0 ? frame.render(width) : [...lines];
              },
              handleMouse(event: TuiMouseEvent) {
                if (!current() || mount !== token || latest === undefined) return undefined;
                return frame?.handleMouse(event);
              },
              invalidate() {
                frame?.invalidate();
              },
              dispose() {
                frame?.dispose();
                // Host disposal must never clear a newer mount or call back into UI.
                if (mount === token) {
                  mount = undefined;
                  needsClear = false;
                }
              },
            };
            token.component = component;
            return component;
          },
          { placement: "aboveEditor" },
        );
      } catch (error) {
        if (writeVersion === attempt) fail(error);
        throw error;
      }
    },
    setCollapsed(collapsed) {
      if (!current() || mode !== "tui" || !name || state.collapsed === collapsed) return false;
      state.collapsed = collapsed;
      mount?.component?.invalidate();
      mount?.tui?.requestRender();
      return true;
    },
    dispose() {
      if (disposed && !needsClear) return;
      disposed = true;
      latest = undefined;
      clear();
    },
  };
}
