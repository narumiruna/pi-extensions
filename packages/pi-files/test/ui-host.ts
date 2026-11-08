import type { AgentSession, ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type KeybindingsConfig,
  type OverlayHandle,
  Spacer,
  type Terminal,
  Text,
  TuiAltScreen,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { sdk } from "./smoke-fixture.js";

const viewportModule = new URL(
  "./modes/interactive/chat-viewport.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
).href;
const { createChatViewport } = await import(viewportModule);
// The native agent matcher is a callback type, not a runtime root export.
const keysModule = new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
const native = await import(keysModule);
export function nativeKeys(bindings: KeybindingsConfig = {}): KeybindingsManager {
  return new native.KeybindingsManager(bindings);
}

interface Mounted {
  component: Component & { dispose?(): void; waitForPending?(): Promise<void> };
  handle?: OverlayHandle;
}

/** Real Pi renderers and dock layout with a non-interactive in-memory terminal. */
export function createScopeUIHost(mode: "regular" | "fullscreen", keys: KeybindingsManager, theme: Theme) {
  const dimensions = { columns: 80, rows: 32 };
  let input = (_data: string) => {};
  const noop = () => {};
  const terminal: Terminal = {
    get columns() {
      return dimensions.columns;
    },
    get rows() {
      return dimensions.rows;
    },
    kittyProtocolActive: false,
    start: (handler) => {
      input = handler;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
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
  const tui = mode === "fullscreen" ? new TuiAltScreen(terminal, false) : new TuiMainScreen(terminal);
  const document = new Text("Native transcript", 0, 0);
  const editor = new Container();
  const widgetsAbove = new Container();
  const footer = new Container();
  const widgets = new Map<string, Component>();
  const calls: unknown[] = [];
  const notifications: string[] = [];
  const opening = new Set<() => void>();
  let mounted: Mounted | undefined;
  let nativeFooter: InstanceType<typeof sdk.FooterComponent> | undefined;
  const resetEditor = () => {
    editor.clear();
    editor.addChild(new Text("> native prompt", 0, 0));
  };
  resetEditor();
  if (tui instanceof TuiAltScreen) {
    tui.setLayoutRoot(
      createChatViewport({
        document,
        pendingMessages: new Container(),
        status: new Container(),
        widgetsAbove,
        editor,
        footer,
      }).root,
    );
  } else {
    for (const component of [document, widgetsAbove, editor, footer]) tui.addChild(component);
  }
  tui.start();

  const custom: ExtensionUIContext["custom"] = (factory, options) =>
    new Promise((resolve, reject) => {
      calls.push(options);
      let active: Mounted | undefined;
      let closed = false;
      const done = (value: Parameters<typeof resolve>[0]) => {
        if (closed) return;
        closed = true;
        if (active?.handle) active.handle.hide();
        else if (active) resetEditor();
        if (mounted === active) mounted = undefined;
        resolve(value);
        active?.component.dispose?.();
        tui.requestRender();
      };
      Promise.resolve(factory(tui, theme, keys, done))
        .then((component) => {
          if (closed) return;
          active = { component };
          if (options?.overlay) {
            const layout =
              typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
            active.handle = tui.showOverlay(component, layout);
            options.onHandle?.(active.handle);
          } else {
            editor.clear();
            editor.addChild(component);
            tui.setFocus(component);
          }
          mounted = active;
          for (const ready of opening) ready();
          opening.clear();
          tui.renderNow();
        })
        .catch(reject);
    });
  const ui = {
    custom,
    notify(message: string) {
      notifications.push(message);
    },
    setWidget: ((key, content) => {
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, typeof content === "function" ? content(tui, theme) : new Text(content.join("\n"), 0, 0));
      widgetsAbove.clear();
      widgetsAbove.addChild(new Spacer(1));
      for (const component of widgets.values()) widgetsAbove.addChild(component);
      tui.requestRender();
    }) satisfies ExtensionUIContext["setWidget"],
  } as unknown as ExtensionUIContext;

  return {
    tui,
    ui,
    calls,
    notifications,
    widgets,
    attach(session: AgentSession, extraFooterRows = 0) {
      nativeFooter = new sdk.FooterComponent(session, {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => noop,
      });
      footer.addChild(nativeFooter);
      if (extraFooterRows)
        footer.addChild(
          new Text(Array.from({ length: extraFooterRows }, () => "Additional footer row").join("\n"), 0, 0),
        );
    },
    async waitForOpen() {
      if (!mounted) await new Promise<void>((resolve) => opening.add(resolve));
      return mounted;
    },
    async pending() {
      await mounted?.component.waitForPending?.();
    },
    send(data: string) {
      input(data);
    },
    resize(columns: number, rows: number) {
      dimensions.columns = columns;
      dimensions.rows = rows;
      tui.invalidate();
    },
    screen() {
      tui.renderNow();
      return tui instanceof TuiAltScreen
        ? tui.getScreenLines()
        : tui.captureRenderState().previousLines.slice(-dimensions.rows);
    },
    dispose() {
      nativeFooter?.dispose();
      tui.stop();
    },
  };
}
