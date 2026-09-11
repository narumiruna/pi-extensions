import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, isFocusable, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { TuiHarness, TuiHarnessKey, TuiHarnessMouseEvent, TuiHarnessOptions, TuiHarnessResize } from "./types.js";

interface HarnessComponent extends Component {
  waitForPending?(): Promise<void>;
  dispose?(): void;
}

type CustomFactory<Value> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: Value) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;
type HarnessKeybindings = NonNullable<TuiHarnessOptions["keybindings"]>;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

interface OpenWaiter {
  resolve(openCount: number): void;
  reject(error: unknown): void;
}

interface HarnessSession {
  generation: number;
  component?: HarnessComponent;
  open: boolean;
  opened: boolean;
  openError?: unknown;
  settled: boolean;
  disposed: boolean;
  result: unknown;
  resultDeferred: Deferred<unknown>;
}

const DEFAULT_WIDTH = 100;
const DEFAULT_ROWS = 24;

export function createTuiHarness(options: TuiHarnessOptions = {}): TuiHarness {
  let width = validDimension(options.width ?? DEFAULT_WIDTH, "width");
  let rows = validDimension(options.rows ?? DEFAULT_ROWS, "rows");
  let openCount = 0;
  let nextGeneration = 0;
  let requestRenderCount = 0;
  let active: HarnessSession | undefined;
  let latest: HarnessSession | undefined;
  let lastFrame: readonly string[] = Object.freeze([]);
  const openWaiters: OpenWaiter[] = [];
  const terminal = {
    get columns() {
      return width;
    },
    get rows() {
      return rows;
    },
  };
  const tui = {
    terminal,
    requestRender() {
      requestRenderCount += 1;
    },
  } as unknown as TUI;
  const theme = testingTheme(options.theme);
  const keybindings = testingKeybindings(options.keybindings);

  const custom = (async <Value>(factory: CustomFactory<Value>, customOptions?: unknown): Promise<Value> => {
    if (customOptions !== undefined) {
      throw new Error("TUI harness does not support custom UI options or overlays");
    }
    if (active && !active.settled) {
      throw new Error("TUI harness already has an active custom component");
    }
    const session: HarnessSession = {
      generation: ++nextGeneration,
      open: false,
      opened: false,
      settled: false,
      disposed: false,
      result: undefined,
      resultDeferred: deferred<unknown>(),
    };
    active = session;
    latest = session;
    const done = (value: Value) => settle(session, value);
    void Promise.resolve()
      .then(() => factory(tui, theme, keybindings, done))
      .then(
        (component) => {
          session.component = component as HarnessComponent;
          if (session.settled) {
            disposeComponent(session);
            return;
          }
          if (active !== session) {
            failSession(
              session,
              new Error(`TUI custom generation ${session.generation} became obsolete before opening`),
            );
            disposeComponent(session);
            return;
          }
          session.open = true;
          session.opened = true;
          openCount += 1;
          resolveOpenWaiters(openCount);
        },
        (error) => failSession(session, error),
      )
      .catch((error) => failSession(session, error));
    try {
      return (await session.resultDeferred.promise) as Value;
    } finally {
      if (active === session) active = undefined;
    }
  }) as ExtensionContext["ui"]["custom"];

  function failSession(session: HarnessSession, error: unknown) {
    if (session.settled) return;
    session.settled = true;
    session.open = false;
    session.openError = error;
    session.resultDeferred.reject(error);
    rejectOpenWaiters(error);
  }

  function settle<Value>(session: HarnessSession, value: Value | undefined) {
    if (session.settled) return;
    const settledBeforeOpen = !session.open && !session.component;
    session.settled = true;
    session.open = false;
    session.result = value;
    session.resultDeferred.resolve(session.result);
    disposeComponent(session);
    if (settledBeforeOpen) {
      const error = new Error("TUI custom component settled before opening");
      session.openError = error;
      rejectOpenWaiters(error);
    }
  }

  function disposeComponent(session: HarnessSession) {
    if (session.disposed || !session.component) return;
    session.disposed = true;
    try {
      session.component.dispose?.();
    } catch {
      // Match Pi's custom host: disposal failures do not replace the component result.
    }
  }

  function resolveOpenWaiters(count: number) {
    for (const waiter of openWaiters.splice(0)) waiter.resolve(count);
  }

  function rejectOpenWaiters(error: unknown) {
    for (const waiter of openWaiters.splice(0)) waiter.reject(error);
  }

  function currentOpen() {
    return active?.open ? active : undefined;
  }

  function render(renderWidth = width): readonly string[] {
    const session = currentOpen();
    if (!session?.component) throw new Error("TUI harness has no open custom component");
    width = validDimension(renderWidth, "width");
    lastFrame = Object.freeze([...session.component.render(width)]);
    return lastFrame;
  }

  function send(data: string): readonly string[] {
    const session = currentOpen();
    if (!session?.component) return lastFrame;
    session.component.handleInput?.(data);
    return session.open ? render() : lastFrame;
  }

  function mouse(event: TuiHarnessMouseEvent): readonly string[] {
    const session = currentOpen();
    if (!session?.component) return lastFrame;
    if (lastFrame.length === 0) render();
    const result = session.component.handleMouse?.({
      type: event.type,
      button: event.button ?? (event.type === "move" || event.type === "wheel" ? "none" : "left"),
      x: event.x,
      y: event.y,
      screenX: event.x,
      screenY: event.y,
      width,
      height: lastFrame.length,
      shift: event.shift ?? false,
      alt: event.alt ?? false,
      ctrl: event.ctrl ?? false,
      ...(event.wheelDelta === undefined ? {} : { wheelDelta: event.wheelDelta }),
      ...(event.clickCount === undefined ? {} : { clickCount: event.clickCount }),
    });
    if (result?.focus && isFocusable(session.component)) session.component.focused = true;
    return session.open ? render() : lastFrame;
  }

  return {
    custom,
    get openCount() {
      return openCount;
    },
    get requestRenderCount() {
      return requestRenderCount;
    },
    get isOpen() {
      return currentOpen() !== undefined;
    },
    get isFocusable() {
      return isFocusable(currentOpen()?.component ?? null);
    },
    get focused() {
      const component = currentOpen()?.component ?? null;
      return isFocusable(component) ? component.focused : false;
    },
    get result() {
      return latest?.result;
    },
    get resultPromise() {
      if (!latest) throw new Error("TUI harness has not opened a custom component");
      return latest.resultDeferred.promise;
    },
    waitForOpen() {
      if (currentOpen()) return Promise.resolve(openCount);
      const session = active ?? latest;
      if (session?.settled && !session.opened && session.openError !== undefined) {
        return Promise.reject(session.openError);
      }
      return new Promise<number>((resolve, reject) => openWaiters.push({ resolve, reject }));
    },
    render,
    press(key: TuiHarnessKey) {
      return send(keyData(key));
    },
    mouse,
    send,
    type(text: string) {
      return send(text);
    },
    resize(size: TuiHarnessResize) {
      const nextWidth = size.width === undefined ? width : validDimension(size.width, "width");
      const nextRows = size.rows === undefined ? rows : validDimension(size.rows, "rows");
      width = nextWidth;
      rows = nextRows;
      return render();
    },
    invalidate() {
      currentOpen()?.component?.invalidate();
    },
    setFocused(focused: boolean) {
      const component = currentOpen()?.component ?? null;
      if (isFocusable(component)) component.focused = focused;
    },
    async waitForPending() {
      await latest?.component?.waitForPending?.();
    },
    dispose() {
      const session = active;
      if (!session || session.settled) return;
      settle(session, undefined);
    },
  };
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function validDimension(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`TUI harness ${name} must be a positive integer`);
  }
  return value;
}

function keyData(key: TuiHarnessKey) {
  switch (key) {
    case "app.models.save":
      return "\u0013";
    case "app.thinking.cycle":
      return "\u001b[Z";
    case "tui.input.tab":
      return "\t";
    case "tui.select.up":
      return "\u001b[A";
    case "tui.select.down":
      return "\u001b[B";
    case "tui.select.pageUp":
      return "\u001b[5~";
    case "tui.select.pageDown":
      return "\u001b[6~";
    case "tui.select.confirm":
    case "tui.input.submit":
      return "\r";
    case "tui.select.cancel":
      return "\u001b";
    case "ctrl+c":
      return "\u0003";
    case "home":
      return "\u001b[H";
    case "end":
      return "\u001b[F";
  }
}

function testingTheme(override?: TuiHarnessOptions["theme"]) {
  const identity = (text: string) => text;
  return {
    fg: (color: Parameters<Theme["fg"]>[0], text: string) => override?.fg(color, text) ?? text,
    bg: (_color: Parameters<Theme["bg"]>[0], text: string) => text,
    bold: (text: string) => override?.bold(text) ?? text,
    italic: identity,
    underline: identity,
    inverse: identity,
    strikethrough: identity,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor" as const,
    getThinkingBorderColor: () => identity,
    getBashModeBorderColor: () => identity,
  } as unknown as Theme;
}

function testingKeybindings(override?: TuiHarnessOptions["keybindings"]) {
  const matches = override?.matches.bind(override);
  const getKeys = override?.getKeys.bind(override);
  return {
    matches(data: string, binding: string) {
      if (matches) return matches(data, binding as Parameters<HarnessKeybindings["matches"]>[1]);
      const expected = bindingKey(binding);
      return (
        (expected !== undefined && matchesKey(data, expected)) ||
        (binding === "tui.select.cancel" && matchesKey(data, Key.ctrl("c")))
      );
    },
    getKeys(binding: string): readonly string[] {
      if (getKeys) return getKeys(binding as Parameters<HarnessKeybindings["getKeys"]>[0]);
      switch (binding) {
        case "app.models.save":
          return ["ctrl+s"];
        case "app.thinking.cycle":
          return ["shift+tab"];
        case "tui.input.tab":
          return ["tab"];
        case "tui.select.up":
          return ["up"];
        case "tui.select.down":
          return ["down"];
        case "tui.select.pageUp":
          return ["pageup"];
        case "tui.select.pageDown":
          return ["pagedown"];
        case "tui.select.confirm":
        case "tui.input.submit":
          return ["enter"];
        case "tui.select.cancel":
          return ["escape", "ctrl+c"];
        default:
          return [];
      }
    },
  } as unknown as KeybindingsManager;
}

function bindingKey(binding: string) {
  switch (binding) {
    case "app.models.save":
      return Key.ctrl("s");
    case "app.thinking.cycle":
      return Key.shift("tab");
    case "tui.input.tab":
      return Key.tab;
    case "tui.select.up":
      return Key.up;
    case "tui.select.down":
      return Key.down;
    case "tui.select.pageUp":
      return Key.pageUp;
    case "tui.select.pageDown":
      return Key.pageDown;
    case "tui.select.confirm":
    case "tui.input.submit":
      return Key.enter;
    case "tui.select.cancel":
      return Key.escape;
    default:
      return undefined;
  }
}
