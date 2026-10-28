import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingsConfig,
  type OverlayHandle,
  type OverlayOptions,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { runNativePointerDemo } from "../scripts/showcase/native-demo.js";
import { createRendererHost, deferred } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

type DisposableComponent = Component & { dispose?(): void };

// Use native renderer/input routing. Only custom()'s public overlay adapter is simulated,
// including exact-handle completion, early close, and component disposal.
function createNativeDemoHost(mode: "regular" | "fullscreen", remap = false, bindings: KeybindingsConfig = {}) {
  const theme = rendererTheme();
  const fixture = createRendererHost(mode, theme, {
    bindings: {
      ...(remap
        ? {
            "tui.select.up": "ctrl+p",
            "tui.select.down": "ctrl+n",
            "tui.select.confirm": "ctrl+y",
            "tui.select.cancel": "ctrl+q",
          }
        : {}),
      ...bindings,
    },
  });
  const mounted = deferred<void>();
  const overlays: { component: DisposableComponent; handle: OverlayHandle; hides: number }[] = [];
  const originalShow = fixture.host.showOverlay.bind(fixture.host);
  fixture.host.showOverlay = (component: DisposableComponent, options?: OverlayOptions) => {
    const handle = originalShow(component, options);
    const entry = { component, handle, hides: 0 };
    overlays.push(entry);
    const hide = handle.hide;
    handle.hide = () => {
      entry.hides++;
      hide();
    };
    return handle;
  };
  let completions = 0;
  let disposals = 0;
  let finish: () => void = () => {};
  let component: DisposableComponent | undefined;
  const custom: ExtensionContext["ui"]["custom"] = (factory, options) =>
    new Promise((resolve, reject) => {
      let closed = false;
      let handle: OverlayHandle | undefined;
      const done = (result: unknown) => {
        if (closed) return;
        closed = true;
        completions++;
        handle?.hide();
        resolve(result as never);
        if (component) {
          disposals++;
          component.dispose?.();
        }
      };
      finish = () => done(undefined);
      Promise.resolve(factory(fixture.host, theme, fixture.keys as never, done)).then((created) => {
        if (closed) return;
        component = created;
        if (!options?.overlay) throw new Error("Native demo must use custom overlay mode");
        const overlayOptions =
          typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
        handle = fixture.host.showOverlay(component, overlayOptions);
        options.onHandle?.(handle);
        fixture.host.flush();
        mounted.resolve();
      }, reject);
    });
  const ctx = fixture.ctx as ExtensionCommandContext;
  ctx.ui.custom = custom;
  const controller = new AbortController();
  let current = true;
  return {
    host: fixture.host,
    editor: fixture.editor,
    scroll: fixture.scroll,
    send: fixture.send,
    resize: fixture.resize,
    theme,
    notifications: fixture.notifications,
    overlays,
    controller,
    get completions() {
      return completions;
    },
    get disposals() {
      return disposals;
    },
    get root() {
      assert.ok(component);
      return component;
    },
    start: () => runNativePointerDemo(ctx, { signal: controller.signal, isCurrent: () => current }),
    opened: () => mounted.promise,
    finish: () => finish(),
    replace: () => {
      current = false;
    },
    text: () => stripVTControlCharacters(component?.render(90).join("\n") ?? ""),
    stop: () => {
      finish();
      fixture.stop();
    },
  };
}

function mouse(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
}

function bounds(handle: OverlayHandle) {
  const value = handle.getBounds();
  assert.ok(value);
  return value;
}

function passive(label: string, inputs: string[] = []): Component {
  return {
    render: () => [label],
    invalidate() {},
    handleInput: (data) => inputs.push(data),
  };
}

for (const unrelated of [false, true]) {
  test(`native demo rejects a host-owned hard cancel before mounting (unrelated overlay: ${unrelated})`, async (t) => {
    const f = createNativeDemoHost("fullscreen", false, { "tui.altScreen.search": "ctrl+c" });
    t.onTestFinished(() => f.stop());
    const existing = unrelated ? f.host.showOverlay(passive("unrelated")) : undefined;
    await f.start();
    assert.equal(f.completions, 1);
    assert.equal(f.disposals, 0);
    assert.equal(f.overlays.length, unrelated ? 1 : 0);
    assert.match(f.notifications[0]?.message ?? "", /native fullscreen binding owns it/u);
    if (existing) {
      assert.equal(existing.isFocused(), true);
      assert.equal(f.overlays[0].hides, 0);
      existing.hide();
    }
  });
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} demo keeps hard cancel when viewport input defers to its overlay`, async (t) => {
    const f = createNativeDemoHost(mode, false, { "tui.altScreen.lineUp": "ctrl+c" });
    t.onTestFinished(() => f.stop());
    const running = f.start();
    await f.opened();
    f.send("\u001b[B");
    f.send("\r");
    assert.equal(f.overlays.length, 2);
    f.send("\u0003");
    await running;
    assert.equal(f.completions, 1);
    assert.deepEqual(
      f.overlays.map(({ hides }) => hides),
      [1, 1],
    );
    assert.deepEqual(f.notifications, []);
  });
}

test("regular demo does not reject a fullscreen-only search binding", async (t) => {
  const f = createNativeDemoHost("regular", false, { "tui.altScreen.search": "ctrl+c" });
  t.onTestFinished(() => f.stop());
  const running = f.start();
  await f.opened();
  f.send("\u0003");
  await running;
  assert.deepEqual(f.notifications, []);
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} native demo keeps parent layout and provides configured keyboard alternatives`, async (t) => {
    const f = createNativeDemoHost(mode, true);
    t.onTestFinished(() => f.stop());
    const children = [...f.host.children];
    let layoutChanges = 0;
    if ("setLayoutRoot" in f.host) {
      f.host.setLayoutRoot = () => {
        layoutChanges++;
      };
    }
    let terminalStops = 0;
    const stop = f.host.terminal.stop;
    f.host.terminal.stop = () => {
      terminalStops++;
      stop();
    };
    const running = f.start();
    await f.opened();
    assert.match(f.text(), /Native pointer \/ wheel \/ overlay routing/u);
    assert.match(f.text(), /Regular: terminal owns mouse\/scrollback/u);
    f.send("\x19"); // remapped confirm toggles wheel policy
    assert.match(f.text(), /Wheel handling: unhandled/u);
    f.send("\x0e");
    f.send("\x19");
    const nested = f.overlays[1];
    assert.ok(nested);
    assert.equal(nested.handle.isFocused(), true);
    f.send("\x11"); // remapped cancel closes only nested overlay
    assert.equal(nested.hides, 1);
    assert.equal(f.completions, 0);
    assert.equal(f.overlays[0]?.handle.isFocused(), true);
    f.send("\x0e");
    f.send("\x19"); // close selected root action
    await running;
    assert.equal(f.completions, 1);
    assert.equal(f.disposals, 1);
    assert.equal(f.overlays[0]?.hides, 1);
    assert.equal(layoutChanges, 0);
    assert.equal(terminalStops, 0);
    assert.deepEqual(f.host.children, children);
    assert.equal(f.host.getFocusedComponent(), f.editor);
    assert.equal(f.editor.getValue(), "main draft");
    f.send("\x1b[F");
    f.send("!");
    assert.equal(f.editor.getValue(), "main draft!");
  });

  test(`${mode} native wheel routing preserves focused overlay and native fallback`, async (t) => {
    const f = createNativeDemoHost(mode);
    t.onTestFinished(() => f.stop());
    const running = f.start();
    await f.opened();
    const root = f.overlays[0];
    assert.ok(root);
    const rect = bounds(root.handle);
    const before = f.scroll.scrollTop;
    f.send(mouse(64, rect.col + 1, rect.row + 1));
    assert.equal(f.scroll.scrollTop, before);
    if (mode === "fullscreen") {
      assert.match(f.text(), /wheel root/u);
      assert.match(f.text(), /handled=true capture=false focus=false/u);
    } else assert.match(f.text(), /No normalized pointer event received/u);
    f.send("\r"); // let wheel reach native fallback
    f.send(mouse(64, rect.col + 1, rect.row + 1));
    if (mode === "fullscreen") {
      assert.ok(f.scroll.scrollTop < before);
      assert.match(f.text(), /handled=false capture=false focus=false/u);
      // Outside the overlay, native transcript routing still works.
      const after = f.scroll.scrollTop;
      f.send(mouse(64, 0, 0));
      assert.ok(f.scroll.scrollTop < after);
    } else assert.equal(f.scroll.scrollTop, before);
    assert.equal(root.handle.isFocused(), true);
    f.send("\x03");
    await running;
  });

  test(`${mode} native press/click/drag uses normalized fields and exact capture target`, async (t) => {
    const f = createNativeDemoHost(mode);
    t.onTestFinished(() => f.stop());
    const running = f.start();
    await f.opened();
    const root = f.overlays[0];
    assert.ok(root);
    const rect = bounds(root.handle);
    const x = rect.col + 1;
    const y = rect.row + 1; // title, not an action
    f.send(mouse(28, x, y)); // primary + Shift + Alt + Ctrl
    if (mode === "fullscreen") {
      assert.match(f.text(), /press root/u);
      assert.match(f.text(), /local=1,1/u);
      assert.match(f.text(), /button=left shift=true alt=true ctrl=true/u);
      assert.match(f.text(), /handled=true capture=true focus=true/u);
    }
    f.send(mouse(28, x, y, true));
    if (mode === "fullscreen") assert.match(f.text(), /click root/u);
    f.send(mouse(0, x, y));
    f.send(mouse(32, 0, 0)); // captured outside overlay bounds
    if (mode === "fullscreen") {
      assert.match(f.text(), /drag root/u);
      assert.match(f.text(), new RegExp(`local=-${rect.col},-${rect.row} screen=0,0`, "u"));
    }
    f.send(mouse(0, 0, 0, true));
    if (mode === "fullscreen") assert.match(f.text(), /release root/u);
    else assert.match(f.text(), /No normalized pointer event received/u);
    f.send("\x1b[200~synthetic-secret-DO-NOT-ECHO\x1b[201~");
    f.send("raw input must not be recorded");
    assert.doesNotMatch(f.text(), /DO-NOT-ECHO|raw input must/u);
    assert.equal(f.editor.getValue(), "main draft");
    f.send("\x03");
    await running;
  });

  test(`${mode} native nested routing handles wheel and captures drag without touching parent layout`, async (t) => {
    const f = createNativeDemoHost(mode);
    t.onTestFinished(() => f.stop());
    const running = f.start();
    await f.opened();
    f.send("\x1b[B");
    f.send("\r");
    const nested = f.overlays[1];
    assert.ok(nested);
    const rect = bounds(nested.handle);
    const x = rect.col + 1;
    const y = rect.row + 1;
    const before = f.scroll.scrollTop;
    f.send(mouse(64, x, y));
    assert.equal(f.scroll.scrollTop, before);
    if (mode === "fullscreen") assert.match(f.text(), /wheel nested/u);
    f.send(mouse(0, x, y));
    f.send(mouse(0, x, y, true));
    if (mode === "fullscreen") assert.match(f.text(), /click nested/u);
    f.send(mouse(0, x, y));
    f.send(mouse(32, 0, 0));
    if (mode === "fullscreen") assert.match(f.text(), /drag nested/u);
    f.send(mouse(0, 0, 0, true));
    f.send("\r"); // complete only the nested overlay
    assert.equal(nested.hides, 1);
    assert.equal(f.completions, 0);
    f.send("\x1b[A");
    f.send("\r"); // disable handling
    f.send("\x1b[B");
    f.send("\r");
    const second = f.overlays[2];
    assert.ok(second);
    const secondRect = bounds(second.handle);
    f.send(mouse(64, secondRect.col + 1, secondRect.row + 1));
    if (mode === "fullscreen") {
      assert.match(f.text(), /wheel nested/u);
      assert.match(f.text(), /handled=false/u);
      assert.ok(f.scroll.scrollTop < before);
    } else assert.equal(f.scroll.scrollTop, before);
    assert.equal(second.handle.isFocused(), true);
    f.send("\x03");
    await running;
  });

  test(`${mode} native click activates only a mapped action and completes the exact root overlay`, async (t) => {
    const f = createNativeDemoHost(mode);
    t.onTestFinished(() => f.stop());
    const running = f.start();
    await f.opened();
    const root = f.overlays[0];
    assert.ok(root);
    const unrelated = f.host.showOverlay(passive("unrelated"), { row: 0, col: 0, width: 12 });
    f.host.flush();
    const rect = bounds(root.handle);
    const actionRow = f.root
      .render(rect.width)
      .findIndex((line) => stripVTControlCharacters(line).includes("Close native demo"));
    assert.ok(actionRow >= 0);
    f.send(mouse(0, rect.col + 1, rect.row + actionRow));
    assert.equal(f.completions, 0); // press captures; activation waits for native click
    f.send(mouse(0, rect.col + 1, rect.row + actionRow, true));
    if (mode === "regular") {
      assert.equal(f.completions, 0); // terminal owns mouse; keyboard alternative remains available
      root.handle.focus();
      f.send("\x1b[A"); // wraps from first action to Close
      f.send("\r");
    }
    await running;
    assert.equal(root.hides, 1);
    assert.equal(f.completions, 1);
    assert.equal(f.overlays[1]?.hides, 0);
    f.host.flush();
    assert.ok(unrelated.getBounds());
    unrelated.hide();
  });

  for (const end of ["nested-hard-cancel", "abort", "dispose", "host-completion", "replacement"] as const) {
    test(`${mode} ${end} releases only owned overlays and settles once`, async (t) => {
      const f = createNativeDemoHost(mode);
      t.onTestFinished(() => f.stop());
      const inputs: string[] = [];
      const unrelatedBefore = f.host.showOverlay(passive("unrelated before", inputs), { row: 0, col: 0, width: 12 });
      const running = f.start();
      await f.opened();
      f.send("\x1b[B");
      f.send("\r");
      const root = f.overlays[1];
      const nested = f.overlays[2];
      assert.ok(root && nested);
      assert.equal(nested.handle.isFocused(), true);
      const unrelatedAfter = f.host.showOverlay(passive("unrelated after", inputs), { row: 0, col: 0, width: 12 });
      nested.handle.focus(); // Ctrl+C must close root even with nested focus.
      if (end === "nested-hard-cancel") f.send("\x03");
      else if (end === "abort") f.controller.abort();
      else if (end === "dispose") f.root.dispose?.();
      else if (end === "host-completion") f.finish();
      else {
        f.replace();
        f.send("x");
      }
      await running;
      f.controller.abort();
      f.root.dispose?.();
      f.finish();
      assert.equal(f.completions, 1);
      assert.equal(f.disposals, 1);
      assert.equal(root.hides, 1);
      assert.equal(nested.hides, 1);
      assert.equal(f.overlays[0]?.hides, 0);
      assert.equal(f.overlays[3]?.hides, 0);
      f.host.flush();
      assert.ok(unrelatedBefore.getBounds());
      assert.ok(unrelatedAfter.getBounds());
      assert.deepEqual(inputs, []); // cancel/replacement key never leaks to a restored component
      unrelatedAfter.focus();
      f.send("z"); // disposed demo listener must not consume future input
      assert.deepEqual(inputs, ["z"]);
      unrelatedAfter.hide();
      unrelatedBefore.hide();
    });
  }

  test(`${mode} cancellation before native overlay mount leaves no handles or listeners`, async (t) => {
    const f = createNativeDemoHost(mode);
    t.onTestFinished(() => f.stop());
    const running = f.start();
    f.controller.abort();
    await running;
    assert.equal(f.overlays.length, 0);
    assert.equal(f.completions, 1);
    f.send("\x1b[F");
    f.send("!");
    assert.equal(f.editor.getValue(), "main draft!");
  });

  test(`${mode} native frames bound resize, preserve selection and use callback theme`, async (t) => {
    const f = createNativeDemoHost(mode);
    t.onTestFinished(() => f.stop());
    const running = f.start();
    await f.opened();
    f.send("\x1b[B");
    const plain = f.text();
    f.theme.fg = (role, text) => `[${role}]${text}`;
    f.root.invalidate();
    assert.match(f.root.render(90).join("\n"), /\[accent\]> Open nested native overlay/u);
    assert.match(f.root.render(90).join("\n"), /\[muted\]Configured select/u);
    for (const rows of [0, 1, 2, 4, 6, 30]) {
      f.resize(100, rows);
      for (const width of [0, 1, 2, 9, 80]) {
        const lines = f.root.render(width);
        assert.ok(lines.length <= Math.floor(rows * 0.9));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      }
    }
    f.resize(100, 30);
    assert.match(plain, /> Open nested native overlay/u);
    f.send("\x03");
    await running;
  });
}

for (const mode of ["rpc", "print", "json"] as const) {
  test(`native demo does not open custom UI in ${mode}`, async () => {
    let calls = 0;
    await runNativePointerDemo({ mode, ui: { custom: () => calls++ } } as unknown as ExtensionCommandContext, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    assert.equal(calls, 0);
  });
}

test("fullscreen native feedback distinguishes move and non-primary button routing", async (t) => {
  const f = createNativeDemoHost("fullscreen");
  t.onTestFinished(() => f.stop());
  const running = f.start();
  await f.opened();
  const root = f.overlays[0];
  assert.ok(root);
  const rect = bounds(root.handle);
  for (const [button, name] of [
    [1, "middle"],
    [2, "right"],
  ] as const) {
    f.send(mouse(button, rect.col + 1, rect.row + 1));
    assert.match(f.text(), /press root/u);
    assert.match(f.text(), new RegExp(`button=${name}`, "u"));
    assert.match(f.text(), /handled=true capture=false focus=false/u);
    f.send(mouse(button, rect.col + 1, rect.row + 1, true));
    assert.match(f.text(), /click root/u);
  }
  f.send(mouse(35, rect.col + 1, rect.row + 1));
  assert.match(f.text(), /move root/u);
  assert.match(f.text(), /button=none/u);
  assert.match(f.text(), /handled=false capture=false focus=false/u);
  f.send("\x03");
  await running;
});

test("native demo does not allocate UI for cancelled or stale ownership", async () => {
  let calls = 0;
  const ctx = { mode: "tui", ui: { custom: () => calls++ } } as unknown as ExtensionCommandContext;
  const cancelled = new AbortController();
  cancelled.abort();
  await runNativePointerDemo(ctx, { signal: cancelled.signal, isCurrent: () => true });
  await runNativePointerDemo(ctx, { signal: new AbortController().signal, isCurrent: () => false });
  assert.equal(calls, 0);
});
