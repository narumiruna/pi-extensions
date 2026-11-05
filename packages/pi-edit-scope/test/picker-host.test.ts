import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  Input,
  type KeybindingsConfig,
  setKeybindings,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { type ScopePickerOptions, showScopePicker } from "../src/picker.js";
import { scopeOverlayContext } from "../src/ui.js";
import { cleanupSmokeRoot } from "./smoke-fixture.js";
import { createScopeUIHost, nativeKeys } from "./ui-host.js";

const originalKeys = getKeybindings();
afterEach(() => setKeybindings(originalKeys));
afterAll(cleanupSmokeRoot);
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

async function mount(
  mode: "regular" | "fullscreen",
  bindings: KeybindingsConfig = {},
  inventory: Partial<Pick<ScopePickerOptions, "targets" | "discover">> = {},
) {
  const keys = nativeKeys(bindings);
  setKeybindings(keys);
  const host = createScopeUIHost(mode, keys, theme);
  const ctx = scopeOverlayContext({ mode: "tui", hasUI: true, ui: host.ui } as unknown as ExtensionCommandContext);
  const validate = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({ path, canonical: path })));
  const resolvePath = vi.fn(async (raw: string) => ({ path: raw, canonical: raw }));
  const running = showScopePicker(ctx, {
    cwd: "/cwd",
    targets: [{ path: "/cwd/a", canonical: "/cwd/a" }],
    completionLabel: "Apply changes",
    signal: new AbortController().signal,
    isCurrent: () => true,
    discover: async () => Array.from({ length: 20 }, (_, index) => `/cwd/file-${index}`),
    resolvePath,
    validate,
    ...inventory,
  });
  const mounted = await host.waitForOpen();
  await host.pending();
  const render = () => stripTerminalSequences((mounted?.component.render(100) ?? []).join("\n"));
  return { host, running, validate, resolvePath, render, mounted };
}

test.each(["regular", "fullscreen"] as const)(
  "%s overlay receives paging, marking, path toggle, and remapped Enter completion",
  async (mode) => {
    const { host, running, validate, render } = await mount(mode, { "tui.select.confirm": "f2" });
    try {
      expect(render()).toContain("tab select");
      expect(render()).toContain("f2 apply");
      for (let index = 0; index < 12; index += 1) host.send("\x1b[B");
      expect(render()).toContain("→ [ ] file-11");
      host.send("\x1b[5~");
      expect(render()).toContain("→ [ ] file-1");
      host.send("\x10");
      expect(render()).toContain("→ [ ] /cwd/file-1");
      host.send("\t");
      expect(render()).toContain("[x] /cwd/file-1");
      expect(render()).toContain("→ [ ] /cwd/file-2");
      host.send("\r");
      expect(validate).not.toHaveBeenCalled();
      host.send("\x1bOQ");
      await running;
      expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a", "/cwd/file-1"]);
    } finally {
      host.send("\x03");
      await running;
      host.dispose();
    }
  },
);

test("fullscreen search interception chooses the first reachable configured confirmation key", async () => {
  const { host, running, validate, render } = await mount("fullscreen", {
    "tui.altScreen.search": "enter",
    "tui.select.confirm": ["enter", "f2"],
  });
  try {
    expect(render()).toContain("f2 apply");
    expect(render()).not.toContain("enter apply");
    host.send("\r");
    expect(validate).not.toHaveBeenCalled();
    host.send("\x1b");
    host.send("\x1bOQ");
    await running;
    expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a"]);
  } finally {
    host.send("\x1b");
    host.send("\x03");
    await running;
    host.dispose();
  }
});

test("fullscreen search keeps priority over Tab; reverse marking remains usable after search closes", async () => {
  const { host, running, validate, render } = await mount("fullscreen", { "tui.altScreen.search": "tab" });
  try {
    expect(render()).not.toContain("• tab select");
    expect(render()).toContain("shift+tab select ↑");
    host.send("\t");
    expect(validate).not.toHaveBeenCalled();
    host.send("\x1b");
    expect(render()).toContain("1 selected");
    host.send("\x1b[Z");
    expect(render()).toContain("→ [ ] a");
    expect(render()).toContain("0 selected");
    host.send("\x1b[Z");
    expect(render()).toContain("→ [x] a");
    expect(render()).toContain("1 selected");
    host.send("\r");
    await running;
    expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a"]);
  } finally {
    host.send("\x1b");
    host.send("\x03");
    await running;
    host.dispose();
  }
});

test("an intercepted path key is omitted and a reachable configured alternative still works", async () => {
  const { host, running, render } = await mount("fullscreen", {
    "tui.altScreen.search": "ctrl+p",
    "app.session.togglePath": ["ctrl+p", "f4"],
  });
  try {
    expect(render()).not.toContain("ctrl+p Full paths");
    expect(render()).toContain("f4 Full paths");
    host.send("\x10");
    host.send("\x1b");
    host.send("\x1bOS");
    expect(render()).toContain("→ [x] /cwd/a");
    host.send("\x03");
    await running;
  } finally {
    host.send("\x1b");
    host.send("\x03");
    await running;
    host.dispose();
  }
});

test("native search mapped to Ctrl+C is not falsely advertised as close", async () => {
  const { host, running, render } = await mount("fullscreen", { "tui.altScreen.search": "ctrl+c" });
  try {
    expect(render()).not.toContain("ctrl+c close");
    expect(render()).toContain("esc cancel");
    host.send("\x03");
    host.send("\x1b");
    expect(render()).toContain("Select files");
    host.send("\x1b");
    expect(await running).toMatchObject({ kind: "completed", value: { kind: "cancelled", reason: "back" } });
  } finally {
    host.send("\x1b");
    host.send("\x1b");
    await running;
    host.dispose();
  }
});

test("Add uses a separate native-focus input without letting Tab mark files from that panel", async () => {
  const { host, running, resolvePath, render } = await mount("fullscreen");
  try {
    host.send("file-1");
    host.send("\x0f");
    expect(render()).toContain("Add existing file");
    host.send("\t");
    host.send("/outside/a file");
    expect(resolvePath).not.toHaveBeenCalled();
    host.send("\r");
    await host.pending();
    expect(render()).toContain("Select files");
    expect(render()).toContain("> file-1");
    expect(render()).toContain("2 selected");
    expect(resolvePath).toHaveBeenCalledWith("/outside/a file", expect.any(AbortSignal));
    host.send("\x03");
    await running;
  } finally {
    host.send("\x03");
    await running;
    host.dispose();
  }
});

test("native SGR press/release keeps the file identity after canonical details compact the frame", async () => {
  const { host, running, mounted, validate, render } = await mount(
    "fullscreen",
    {},
    {
      targets: [
        { path: "/cwd/a", canonical: "/cwd/a" },
        { path: "/cwd/b", canonical: "/outside/b" },
      ],
      discover: async () => ["/cwd/c"],
    },
  );
  let other: ReturnType<typeof host.tui.showOverlay> | undefined;
  try {
    host.resize(100, 15);
    other = host.tui.showOverlay(new Input(), { anchor: "top-right", width: 20 });
    host.screen();
    expect(mounted?.handle?.isFocused()).toBe(false);
    const frame = mounted?.component.render(100) ?? [];
    const row = frame.findIndex((line) => line.includes("[x] b"));
    const bounds = mounted?.handle?.getBounds();
    if (!bounds || row < 0) throw new Error("Picker file geometry is missing");
    const point = `${bounds.col + 6};${bounds.row + row + 1}`;
    host.send(`\x1b[<0;${point}M`);
    host.screen();
    expect(mounted?.handle?.isFocused()).toBe(true);
    expect(render()).toContain("Canonical target: /outside/b");
    host.send(`\x1b[<0;${point}m`);
    expect(render()).toContain("1 selected");
    host.send("\r");
    await running;
    expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a"]);
  } finally {
    other?.hide();
    host.send("\x03");
    await running;
    host.dispose();
  }
});

test("debug, consuming listeners, and an unrelated overlay keep ownership of their input", async () => {
  const { host, running, validate, render } = await mount("fullscreen", { "app.session.togglePath": "shift+ctrl+d" });
  const debug = vi.fn();
  host.tui.onDebug = debug;
  const unsubscribe = host.tui.addInputListener((data) => (data === "\r" ? { consume: true } : undefined));
  let other: ReturnType<typeof host.tui.showOverlay> | undefined;
  try {
    host.send("\x1b[100;6u");
    expect(debug).toHaveBeenCalledOnce();
    expect(render()).toContain("→ [x] a");
    host.send("\r");
    expect(validate).not.toHaveBeenCalled();
    unsubscribe();
    other = host.tui.showOverlay(new Input(), { width: 30 });
    host.send("\r");
    expect(validate).not.toHaveBeenCalled();
    other.hide();
    other = undefined;
    host.send("\r");
    await running;
    expect(validate).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
    other?.hide();
    host.send("\x03");
    await running;
    host.dispose();
  }
});
