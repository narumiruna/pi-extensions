import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export interface EditorStatusPublisher<T> {
  publish(snapshot: T | undefined): void;
  dispose(): void;
}

export interface EditorStatusPublisherOptions<T> {
  key: string;
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
  if (!isCurrent()) return { publish() {}, dispose() {} };
  const { mode, hasUI } = options.context;
  if (!hasUI || (mode !== "tui" && mode !== "rpc")) return { publish() {}, dispose() {} };
  const ui = options.context.ui;
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
            const component = {
              render(width: number): string[] {
                if (!current() || mount !== token || latest === undefined) return [];
                // ui.theme is Pi's current callback theme, including replacements
                // after a theme change. Do not retain themed lines or the first theme.
                return [...render(latest, ui.theme, width, tui.terminal.rows)];
              },
              invalidate() {},
              dispose() {
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
    dispose() {
      if (disposed && !needsClear) return;
      disposed = true;
      latest = undefined;
      clear();
    },
  };
}
