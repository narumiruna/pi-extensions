import type {
  KeybindingsManager as AppKeybindingsManager,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getKeybindings,
  Input,
  isKittyProtocolActive,
  type KeybindingsConfig,
  KeybindingsManager,
  ScrollView,
  setKeybindings,
  setKittyProtocolActive,
  type Terminal,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  type TuiAltScreenOptions,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { createMockContext } from "../../../../test/support.js";

// Use the real Pi renderers and terminal input pipeline, not component.handleInput().
// Only the extension custom-dialog adapter is simulated; it follows showExtensionCustom's
// early-close behavior, including discarding a factory result that arrives after close.
class MainHost extends TuiMainScreen {
  flush() {
    this.doRender();
  }
}

class FullscreenHost extends TuiAltScreen {
  constructor(terminal: Terminal, options: TuiAltScreenOptions) {
    super(terminal, false, undefined, options);
  }

  flush() {
    this.doRender();
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function createRendererHost(
  mode: "regular" | "fullscreen",
  theme: Theme,
  options: { bindings?: KeybindingsConfig; kitty?: boolean; width?: number; rows?: number } = {},
) {
  const previousKeys = getKeybindings();
  const previousKitty = isKittyProtocolActive();
  const keys = new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.message.copy": { defaultKeys: "ctrl+x", description: "Copy document" },
      "app.models.save": { defaultKeys: "ctrl+s", description: "Save default model" },
      "app.thinking.save": { defaultKeys: "ctrl+s", description: "Save default thinking" },
      "app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking" },
    },
    options.bindings,
  );
  setKeybindings(keys);
  setKittyProtocolActive(options.kitty ?? false);
  let input: (data: string) => void = () => {
    throw new Error("Terminal not started");
  };
  const noop = () => {};
  const writes: string[] = [];
  const urls: string[] = [];
  let columns = options.width ?? 100;
  let rows = options.rows ?? 30;
  const terminal: Terminal = {
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    kittyProtocolActive: options.kitty ?? false,
    start(onInput) {
      input = onInput;
    },
    stop: noop,
    drainInput: async () => {},
    write: (data) => writes.push(data),
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
  const host =
    mode === "regular"
      ? new MainHost(terminal, false)
      : new FullscreenHost(terminal, {
          wheelScrollLines: 1,
          openUrl: (url) => {
            urls.push(url);
          },
        });
  const editor = new Input();
  editor.setValue("main draft");
  const dock = new Container();
  dock.addChild(editor);
  const transcript = new Text(Array.from({ length: 100 }, (_, index) => `history ${index}`).join("\n"), 0, 0);
  const scroll = new ScrollView(transcript, { primary: true, follow: "end" });
  if (host instanceof FullscreenHost) {
    host.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, minSize: 1 }, dock]));
  } else {
    host.addChild(transcript);
    host.addChild(dock);
  }
  host.setFocus(editor);
  let component: (Component & { dispose?(): void }) | undefined;
  let close: () => void = noop;
  let opened = deferred<void>();
  let stopped = false;
  const custom = (async (factory, customOptions) => {
    if (customOptions !== undefined) throw new Error("Renderer fixture supports replacement dialogs only");
    // Keep the initial readiness promise for factories reached after a lazy import.
    // Replacing it before the first mount strands a caller already waiting for open.
    if (component) opened = deferred<void>();
    component = undefined;
    const result = deferred<unknown>();
    let closed = false;
    const saved = editor.getValue();
    const restore = () => {
      dock.clear();
      dock.addChild(editor);
      editor.setValue(saved);
      host.setFocus(editor);
      host.requestRender();
    };
    const done = (value: unknown) => {
      if (closed) return;
      closed = true;
      restore();
      result.resolve(value);
      try {
        component?.dispose?.();
      } catch {
        // Pi ignores disposal errors when closing custom UI.
      }
    };
    close = () => done(undefined);
    void Promise.resolve(factory(host, theme, keys as AppKeybindingsManager, done)).then(
      (created) => {
        if (closed) return;
        component = created;
        dock.clear();
        dock.addChild(created);
        host.setFocus(created);
        host.flush();
        opened.resolve();
      },
      (error) => {
        if (closed) return;
        closed = true;
        restore();
        result.reject(error);
      },
    );
    return result.promise;
  }) as ExtensionContext["ui"]["custom"];
  const context = createMockContext({ mode: "tui", hasUI: true, custom });
  host.start();
  host.flush();
  return {
    ...context,
    host,
    editor,
    scroll,
    urls,
    writes,
    keys,
    waitForOpen: () => opened.promise,
    get component() {
      return requireComponent();
    },
    frame(width = terminal.columns) {
      return requireComponent().render(width);
    },
    send(data: string) {
      input(data);
      host.flush();
    },
    resize(width: number, terminalRows: number) {
      columns = width;
      rows = terminalRows;
      host.invalidate();
      host.flush();
    },
    close: () => close(),
    stop() {
      if (stopped) return;
      stopped = true;
      close();
      host.stop();
      setKeybindings(previousKeys);
      setKittyProtocolActive(previousKitty);
    },
  };
  function requireComponent() {
    if (!component) throw new Error("Custom component not mounted");
    return component;
  }
}
