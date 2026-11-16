import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  isKittyProtocolActive,
  ScrollView,
  setKittyProtocolActive,
  type Terminal,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark", false);

class FullscreenHost extends TuiAltScreen {
  flush() {
    this.doRender();
  }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("fullscreen viewport-owned cancel keys are not advertised, while Ctrl+C cancels the owned save", async (t) => {
  const keys = getKeybindings();
  const previousBindings = keys.getUserBindings();
  const previousKitty = isKittyProtocolActive();
  keys.setUserBindings({ "tui.select.cancel": "pageDown" });
  setKittyProtocolActive(false);
  vi.stubEnv("PI_USAGE_KIMI_CODING_API_KEY", "");
  const root = await mkdtemp(join(tmpdir(), "kimi-usage-save-rendering-"));
  const path = join(root, "pi-usage.json");
  await writeFile(path, JSON.stringify({ kimiCodingUsageApiKey: "prior-key" }), { mode: 0o600 });
  const entered = gate();
  const release = gate();
  const runtime = createUsageSettingsRuntime({
    path,
    operations: {
      rename: async (from, to) => {
        entered.resolve();
        await release.promise;
        await rename(from, to);
      },
    },
  });
  await runtime.reload();
  const noop = () => {};
  let terminalInput = (_data: string) => {};
  const terminal: Terminal = {
    columns: 120,
    rows: 30,
    kittyProtocolActive: false,
    start(onInput) {
      terminalInput = onInput;
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
  const tui = new FullscreenHost(terminal, false);
  const editor = new Input();
  editor.setValue("draft");
  const dock = new Container();
  dock.addChild(editor);
  const scroll = new ScrollView(new Text(Array.from({ length: 100 }, (_, i) => `history ${i}`).join("\n"), 0, 0), {
    primary: true,
    follow: "end",
  });
  tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, minSize: 1 }, dock]));
  tui.setFocus(editor);
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    editor: Object.assign(editor, {
      getText: () => editor.getValue(),
      setText: (text: string) => editor.setValue(text),
    }),
    editorContainer: dock,
    extensionDialogs: [],
    keybindings: keys,
    programStatus: { setBlocked() {} },
    ui: tui,
  }) as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  const context = createMockContext({ mode: "tui", hasUI: true });
  const ctx = context.ctx as ExtensionCommandContext;
  ctx.ui.custom = (factory, options) => host.showExtensionCustom(factory, options);
  const owner = new AbortController();
  let settled = false;
  const running = showUsageSettings(
    ctx,
    runtime,
    owner.signal,
    () => true,
    () => {},
  ).finally(() => {
    settled = true;
  });
  t.onTestFinished(async () => {
    owner.abort();
    release.resolve();
    try {
      await running;
      await runtime.flush();
    } finally {
      try {
        tui.stop();
      } finally {
        keys.setUserBindings(previousBindings);
        setKittyProtocolActive(previousKitty);
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const send = (data: string) => {
    terminalInput(data);
    tui.flush();
  };
  const frame = () => stripVTControlCharacters(tui.getFocusedComponent()?.render(120).join("\n") ?? "");
  tui.start();
  tui.flush();
  await vi.waitFor(() => assert.ok(frame().includes("pi-usage Settings")));
  for (let row = 0; row < 5; row++) send("\u001b[B");
  send("\r");
  send("\r");
  await vi.waitFor(() => assert.ok(frame().includes("Official Kimi usage key")));
  send("replacement-key");
  send("\r");
  await entered.promise;
  await vi.waitFor(() => assert.ok(frame().includes("Saving Kimi usage credential")));
  const hintFrame = frame();
  scroll.scrollToStart();
  tui.flush();
  const before = scroll.scrollTop;
  send("\u001b[6~");
  const viewportScrolled = scroll.scrollTop > before;
  const afterViewport = { settled, frame: frame() };
  send("\u0003");
  await Promise.resolve();
  const canceled = { settled, focused: tui.getFocusedComponent() === editor };
  release.resolve();
  assert.equal(await running, true);
  assert.match(hintFrame, /Ctrl\+C cancel/u);
  assert.doesNotMatch(hintFrame, /pagedown|pageDown|Esc/u);
  assert.equal(viewportScrolled, true);
  assert.equal(afterViewport.settled, false);
  assert.match(afterViewport.frame, /Saving Kimi usage credential/u);
  assert.deepEqual(canceled, { settled: false, focused: true });
  assert.equal(runtime.get().settings.kimiCodingUsageApiKey, "replacement-key");
  send("\u001b[F");
  send("!");
  assert.equal(editor.getValue(), "draft!");
});
