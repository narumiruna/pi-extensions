import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  type OverlayHandle,
  type Terminal,
  TuiAltScreen,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

/** Drives the real TUI dispatch pipeline without stdin, stdout, or a CLI. */
export class FullscreenTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  inputDepth = 0;
  events: { name: string; depth: number }[] = [];
  writes: string[] = [];
  onInput: ((data: string) => void) | undefined;
  onResize: (() => void) | undefined;
  drain: () => Promise<void> = () => Promise.resolve();
  start(onInput: (data: string) => void, onResize: () => void) {
    this.events.push({ name: "start", depth: this.inputDepth });
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop() {
    this.events.push({ name: "stop", depth: this.inputDepth });
    this.onInput = undefined;
    this.onResize = undefined;
  }
  async drainInput() {
    this.events.push({ name: "drain", depth: this.inputDepth });
    await this.drain();
  }
  input(data: string) {
    this.inputDepth++;
    try {
      this.onInput?.(data);
    } finally {
      this.inputDepth--;
    }
  }
  write(data: string) {
    this.writes.push(data);
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

export function createFullscreenHarness(mode: "regular" | "fullscreen" = "regular", keybindings = getKeybindings()) {
  const terminal = new FullscreenTerminal();
  const parent = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  let host: (Component & { dispose?(): void }) | undefined;
  let closes = 0;
  let closeCustom: (() => void) | undefined;
  const handles: OverlayHandle[] = [];
  let editorText = "parent draft";
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      getEditorText: () => editorText,
      setEditorText: (text: string) => {
        editorText = text;
      },
      custom: <Value>(
        factory: (
          tui: typeof parent,
          theme: Theme,
          keys: typeof keybindings,
          done: (value: Value) => void,
        ) => Component & { dispose?(): void },
        options?: { onHandle?(handle: OverlayHandle): void },
      ) =>
        new Promise<Value>((resolve, reject) => {
          let handle: OverlayHandle | undefined;
          let closed = false;
          const done = (value: Value) => {
            if (closed) return;
            closed = true;
            closes++;
            handle?.hide();
            resolve(value);
            host?.dispose?.();
          };
          closeCustom = () => done(undefined as Value);
          // Match Pi's asynchronous mount and ownership-specific close behavior.
          try {
            host = factory(parent, {} as Theme, keybindings, done);
            Promise.resolve()
              .then(() => {
                if (closed || !host) return;
                handle = parent.showOverlay(host);
                handles.push(handle);
                options?.onHandle?.(handle);
              })
              .catch(reject);
          } catch (error) {
            reject(error);
          }
        }),
    },
  } as unknown as ExtensionCommandContext;
  parent.start();
  return {
    ctx,
    parent,
    terminal,
    get host() {
      return host;
    },
    get closes() {
      return closes;
    },
    disposeCustom() {
      closeCustom?.();
    },
    dispose() {
      host?.dispose?.();
      for (const handle of handles) handle.hide();
      parent.stop({ preserveScreen: true });
    },
  };
}

export async function fullscreenMounted(): Promise<void> {
  // Let mount and resolved native-drain continuations finish in this event-loop
  // turn. Explicit drain gates still block transfer; no fixed sleep is needed.
  await new Promise<void>((resolve) => setImmediate(resolve));
}
