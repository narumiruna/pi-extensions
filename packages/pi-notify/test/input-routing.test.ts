import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import type { NotificationProvider } from "../src/provider.js";
import { defaults } from "../src/settings.js";

/** Feed the renderer through Terminal.start(), without private input APIs or a real terminal. */
function renderer(fullscreen: boolean, overlay: boolean) {
  let input: ((data: string) => void) | undefined;
  const terminal: Terminal = {
    columns: 60,
    rows: 12,
    kittyProtocolActive: false,
    start(onInput) {
      input = onInput;
    },
    stop() {
      input = undefined;
    },
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
  const host = fullscreen ? new TuiAltScreen(terminal, false) : new TuiMainScreen(terminal, false);
  const content = { render: () => Array.from({ length: 40 }, (_, index) => `Line ${index}`), invalidate() {} };
  host.addChild(content);
  host.setFocus(content);
  host.start();
  if (overlay) host.showOverlay({ render: () => ["Overlay"], invalidate() {} }, { width: 20, anchor: "center" });
  host.renderNow(true);
  return {
    host,
    feed(data: string) {
      if (!input) throw new Error("Terminal is not started.");
      input(data);
    },
  };
}

const routes = [
  { name: "focus in", data: "\x1b[I", forwardedFullscreen: false, activity: true },
  { name: "focus out", data: "\x1b[O", forwardedFullscreen: false, activity: false },
  { name: "left press", data: "\x1b[<0;3;3M", forwardedFullscreen: false, activity: true },
  { name: "left release", data: "\x1b[<0;3;3m", forwardedFullscreen: false, activity: false },
  { name: "motion", data: "\x1b[<35;3;3M", forwardedFullscreen: false, activity: false },
  { name: "legacy press", data: "\x1b[M !!", forwardedFullscreen: false, activity: true },
  { name: "wheel up", data: "\x1b[<64;3;3M", forwardedFullscreen: false, activity: true },
  { name: "wheel down", data: "\x1b[<65;3;3M", forwardedFullscreen: false, activity: true },
  { name: "legacy wheel", data: "\x1b[M`!!", forwardedFullscreen: false, activity: true },
  { name: "page up", data: "\x1b[5~", forwardedFullscreen: false, overlayFallback: true, activity: true },
  { name: "page down", data: "\x1b[6~", forwardedFullscreen: false, overlayFallback: true, activity: true },
  { name: "previous prompt", data: "\x1b[1;5A", forwardedFullscreen: false, overlayFallback: true, activity: true },
  { name: "top", data: "\x1b[1;5H", forwardedFullscreen: false, overlayFallback: true, activity: true },
  { name: "bottom", data: "\x1b[1;5F", forwardedFullscreen: false, overlayFallback: true, activity: true },
  { name: "text", data: "x", forwardedFullscreen: true, activity: true },
  { name: "paste", data: "\x1b[200~hello\x1b[201~", forwardedFullscreen: true, activity: true },
  { name: "key release", data: "\x1b[97;1:3u", forwardedFullscreen: true, activity: false },
  { name: "cell-size reply", data: "\x1b[6;10;20t", forwardedFullscreen: true, activity: false },
];

afterEach(() => vi.useRealTimers());

for (const fullscreen of [false, true])
  for (const overlay of [false, true]) {
    it.each(routes)(
      `uses real ${fullscreen ? "fullscreen" : "regular"} listener order, overlay=${overlay}: $name`,
      async ({ data, forwardedFullscreen, overlayFallback, activity }) => {
        vi.useFakeTimers();
        const previous = getKeybindings();
        setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
        const { host, feed } = renderer(fullscreen, overlay);
        const send = vi.fn<NotificationProvider["send"]>().mockResolvedValue({ state: "accepted" });
        const destination = { provider: "telegram" as const, label: "test", chatId: "123", botToken: "not-used" };
        const provider: NotificationProvider = { id: "telegram", label: "fake", validate: () => destination, send };
        const coordinator = new Coordinator(
          {
            ...defaults(),
            enabled: true,
            mode: "after-inactivity",
            targetIds: ["one"],
            destinations: { one: destination },
          },
          new Map([["telegram", provider]]),
          true,
          async (value) => ({ id: value.id, title: "test", body: "", settledAt: value.settledAt }),
        );
        const observed: string[] = [];
        // InteractiveMode.addExtensionTerminalInputListener() uses this public method after host creation.
        const unsubscribe = host.addInputListener((value) => {
          observed.push(value);
          coordinator.input(value);
        });
        coordinator.observeActivity();
        try {
          coordinator.begin();
          coordinator.settle(false, { cwd: "/test", sessionId: "test" });
          feed(data);
          const forwarded = !fullscreen || forwardedFullscreen || (overlay && overlayFallback === true);
          expect(observed).toEqual(forwarded ? [data] : []);
          expect(coordinator.pendingAt === undefined).toBe(forwarded && activity);
          await vi.advanceTimersByTimeAsync(30000);
          expect(send).toHaveBeenCalledTimes(forwarded && activity ? 0 : 1);
        } finally {
          unsubscribe();
          await coordinator.close();
          host.stop({ preserveScreen: true });
          setKeybindings(previous);
        }
      },
    );
  }

it("does not observe fullscreen search controls or input consumed by an earlier listener", () => {
  vi.useFakeTimers();
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": "ctrl+q" }));
  const { host, feed } = renderer(true, false);
  const observed: string[] = [];
  const unsubscribe = host.addInputListener((data) => {
    observed.push(data);
  });
  try {
    feed("\x11"); // Configured search activation.
    host.renderNow(true);
    feed("\r");
    feed("\x1b[13;2u");
    feed("\x1b");
    expect(observed).toEqual([]);
    feed("x");
    expect(observed).toEqual(["x"]);
  } finally {
    unsubscribe();
    host.stop({ preserveScreen: true });
    setKeybindings(previous);
  }
  const regular = renderer(false, false);
  const block = regular.host.addInputListener(() => ({ consume: true }));
  const observer = regular.host.addInputListener((data) => {
    observed.push(data);
  });
  try {
    regular.feed("y");
    expect(observed).toEqual(["x"]);
  } finally {
    observer();
    block();
    regular.host.stop({ preserveScreen: true });
  }
});
