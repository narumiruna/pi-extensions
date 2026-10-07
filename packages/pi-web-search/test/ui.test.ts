import assert from "node:assert/strict";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { DEFAULTS, type Settings } from "../src/settings.js";
import { showSettings } from "../src/settings-ui.js";

type Screen = Component & { focused?: boolean; dispose?(): void };
function screenHarness(keys: KeybindingsManager, onRender = () => {}) {
  let screen!: Screen;
  let finish!: () => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const mock = createMockContext({
    mode: "tui",
    custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Screen) =>
      new Promise<void>((resolve) => {
        finish = resolve;
        screen = factory(
          { requestRender: onRender },
          { fg: (_role: string, value: string) => value, bold: (value: string) => value },
          keys,
          () => {
            screen?.dispose?.();
            resolve();
          },
        );
        screen.focused = true;
        opened();
      }),
  });
  return {
    ctx: mock.ctx as unknown as ExtensionCommandContext,
    notifications: mock.notifications,
    ready,
    finish: () => finish(),
    get screen() {
      return screen;
    },
  };
}

test.each(["ctrl+x", "alt+x", "ctrl+shift+x", "shift+ctrl+x", "bad-binding"])(
  "settings cancellation retains hard Ctrl+C with configured cancel %s",
  async (cancel) => {
    initTheme("dark", false);
    const previous = getKeybindings();
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": cancel as never });
    setKeybindings(keys);
    const harness = screenHarness(keys);
    const lifetime = new AbortController();
    let changes = 0;
    const running = showSettings(
      harness.ctx,
      () => ({ ...DEFAULTS, apiToken: "TOP_SECRET" }),
      async () => {
        changes++;
      },
      lifetime.signal,
    );
    try {
      await harness.ready;
      const rendered = harness.screen.render(80).join("\n");
      assert.doesNotMatch(rendered, /TOP_SECRET/);
      assert.match(rendered, /present in settings file/);
      for (const width of [0, 1, 12, 40, 80])
        assert.ok(harness.screen.render(width).every((line) => visibleWidth(line) <= width));
      harness.screen.invalidate();
      harness.screen.handleInput?.("\u0003");
      await running;
      assert.equal(changes, 0);
    } finally {
      harness.screen.dispose?.();
      setKeybindings(previous);
    }
  },
);

test("Input retains focus, non-default Backspace, paste, submission and submenu cancellation", async () => {
  initTheme("dark", false);
  const previous = getKeybindings();
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.editor.deleteCharBackward": "ctrl+q",
    "tui.select.cancel": "ctrl+x",
  });
  setKeybindings(keys);
  const harness = screenHarness(keys);
  let settings: Settings = { ...DEFAULTS };
  let saved!: () => void;
  const changed = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const running = showSettings(
    harness.ctx,
    () => settings,
    async (patch) => {
      settings = { ...settings, ...patch };
      saved();
    },
    new AbortController().signal,
  );
  try {
    await harness.ready;
    harness.screen.handleInput?.("\r"); // account ID submenu
    harness.screen.focused = true;
    harness.screen.handleInput?.("ab");
    harness.screen.handleInput?.("\u0011");
    harness.screen.handleInput?.(`\u001b[200~${"c".repeat(31)}\u001b[201~`);
    harness.screen.handleInput?.("\r");
    await changed;
    assert.equal(settings.accountId, `a${"c".repeat(31)}`);
    harness.screen.handleInput?.("\r");
    harness.screen.handleInput?.("\u0018"); // cancel only submenu
    assert.match(harness.screen.render(80).join("\n"), /Cloudflare account ID/);
    harness.screen.handleInput?.("\u0018");
    await running;
  } finally {
    harness.screen.dispose?.();
    setKeybindings(previous);
  }
});

test("pasted controls cannot trigger shortcuts or escape through the invalid-draft preview", async () => {
  initTheme("dark", false);
  const previous = getKeybindings();
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+x" });
  setKeybindings(keys);
  const harness = screenHarness(keys);
  let patch: Partial<Settings> | undefined;
  let saved!: () => void;
  const changed = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const running = showSettings(
    harness.ctx,
    () => ({ ...DEFAULTS }),
    async (value) => {
      patch = value;
      saved();
    },
    new AbortController().signal,
  );
  try {
    await harness.ready;
    harness.screen.handleInput?.("\r");
    harness.screen.handleInput?.("\u001b[200~");
    harness.screen.handleInput?.("\u0003");
    harness.screen.handleInput?.("\u0018");
    harness.screen.handleInput?.("\u001b]52;c;secret\u0007a\u202e\u2066");
    harness.screen.handleInput?.("\u001b[201~");
    const preview = harness.screen.render(80).join("\n");
    assert.match(preview, /Invalid characters/);
    assert.ok(!preview.includes("\u001b]52"));
    assert.ok(!preview.includes("\u0003"));
    assert.doesNotMatch(preview, /\p{Bidi_Control}/u);
    harness.screen.handleInput?.("\r");
    await changed;
    assert.ok(patch?.accountId?.includes("\u0003")); // validation sees the original invalid draft
    assert.ok(patch?.accountId?.includes("\u001b]52"));
    assert.ok(patch?.accountId?.includes("\u202e\u2066"));
    harness.screen.handleInput?.("\u0018");
    await running;
  } finally {
    harness.screen.dispose?.();
    setKeybindings(previous);
  }
});

test("UI edits serialize, recover from failure and restore displayed effective values", async () => {
  initTheme("dark", false);
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const harness = screenHarness(keys);
  let settings: Settings = { ...DEFAULTS };
  let release!: () => void;
  let started!: () => void;
  let finished!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const second = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const changes: Partial<Settings>[] = [];
  const running = showSettings(
    harness.ctx,
    () => settings,
    async (patch) => {
      changes.push(patch);
      if (changes.length === 1) {
        started();
        await gate;
        throw new Error("failure");
      }
      settings = { ...settings, ...patch };
      finished();
    },
    new AbortController().signal,
  );
  await harness.ready;
  for (let i = 0; i < 3; i++) harness.screen.handleInput?.("\u001b[B");
  harness.screen.handleInput?.("\r");
  await ready;
  harness.screen.handleInput?.("\r");
  assert.equal(changes.length, 1);
  release();
  await second;
  await Promise.resolve();
  assert.equal(changes.length, 2);
  assert.equal(settings.exposure, "deferred");
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.screen.render(100).join("\n"), /deferred/);
  harness.screen.handleInput?.("\u0003");
  await running;
});

test("saving adopts all external fields in displayed rows and subsequent cycles", async () => {
  initTheme("dark", false);
  let settings: Settings = { ...DEFAULTS };
  const latest: Settings = {
    ...DEFAULTS,
    accountId: "b".repeat(32),
    gatewayId: "external-gateway",
    byokAlias: "external-key",
    limit: 8,
    timeoutMs: 60000,
  };
  const patches: Partial<Settings>[] = [];
  let refreshed!: () => void;
  const rendered = new Promise<void>((resolve) => {
    refreshed = resolve;
  });
  let cycled!: () => void;
  const updated = new Promise<void>((resolve) => {
    cycled = resolve;
  });
  const harness = screenHarness(new KeybindingsManager(TUI_KEYBINDINGS), () => {
    if (settings.limit === 8) refreshed();
    if (settings.limit === 9) cycled();
  });
  const running = showSettings(
    harness.ctx,
    () => settings,
    async (patch) => {
      patches.push(patch);
      settings = { ...latest, ...patch };
      Object.assign(latest, patch);
    },
    new AbortController().signal,
  );
  try {
    await harness.ready;
    for (let i = 0; i < 3; i++) harness.screen.handleInput?.("\u001b[B");
    harness.screen.handleInput?.("\r");
    await rendered;
    const lines = harness.screen.render(130).join("\n");
    assert.match(lines, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    assert.match(lines, /external-gateway/);
    assert.match(lines, /external-key/);
    assert.match(lines, /Default result limit.*8/);
    assert.match(lines, /Request timeout.*60000/);
    harness.screen.handleInput?.("\u001b[B");
    harness.screen.handleInput?.("\r");
    assert.deepEqual(patches, [{ exposure: "direct" }]);
    await updated;
    assert.deepEqual(patches, [{ exposure: "direct" }, { limit: 9 }]);
    assert.equal(settings.limit, 9);
  } finally {
    harness.screen.handleInput?.("\u0003");
    await running;
  }
});

test("closing waits for a committed save to settle before returning to the command", async () => {
  initTheme("dark", false);
  const harness = screenHarness(new KeybindingsManager(TUI_KEYBINDINGS));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let completed = false;
  const running = showSettings(
    harness.ctx,
    () => ({ ...DEFAULTS }),
    async () => {
      started();
      await gate;
    },
    new AbortController().signal,
  ).then(() => {
    completed = true;
  });
  await harness.ready;
  for (let i = 0; i < 3; i++) harness.screen.handleInput?.("\u001b[B");
  harness.screen.handleInput?.("\r");
  await ready;
  harness.screen.handleInput?.("\u0003");
  await Promise.resolve();
  assert.equal(completed, false);
  release();
  await running;
  assert.ok(completed);
});

test.each(["dispose", "session"])("owned pending saves are cancelled on %s", async (reason) => {
  initTheme("dark", false);
  const harness = screenHarness(new KeybindingsManager(TUI_KEYBINDINGS));
  const lifetime = new AbortController();
  let started!: () => void;
  let settled!: () => void;
  let observed: AbortSignal | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const running = showSettings(
    harness.ctx,
    () => ({ ...DEFAULTS }),
    async (_patch, signal) => {
      observed = signal;
      started();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      settled();
    },
    lifetime.signal,
  );
  await harness.ready;
  for (let i = 0; i < 3; i++) harness.screen.handleInput?.("\u001b[B");
  harness.screen.handleInput?.("\r");
  await ready;
  if (reason === "session") lifetime.abort();
  else {
    harness.screen.dispose?.();
    harness.finish();
    lifetime.abort();
  }
  await stopped;
  await running;
  assert.ok(observed?.aborted);
  assert.equal(harness.notifications.length, 0);
});

function mouseEvent(type: TuiMouseEvent["type"], width: number, height: number, y: number, x = 3): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x + 10,
    screenY: y + 20,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
  };
}
function mouseHarness() {
  initTheme("dark", false);
  let settings: Settings = { ...DEFAULTS };
  const patches: Partial<Settings>[] = [];
  let saved!: () => void;
  const changed = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const h = screenHarness(new KeybindingsManager(TUI_KEYBINDINGS), () => {
    if (patches.length) saved();
  });
  const running = showSettings(
    h.ctx,
    () => settings,
    async (patch) => {
      patches.push(patch);
      settings = { ...settings, ...patch };
    },
    new AbortController().signal,
  );
  const host = new Container();
  return {
    ...h,
    get screen() {
      return h.screen;
    },
    host,
    patches,
    changed,
    running,
    async mount() {
      await h.ready;
      host.addChild(h.screen);
    },
    async close() {
      h.screen.handleInput?.("\u0003");
      await running;
    },
  };
}
const mouseRows = [
  { label: "Cloudflare account ID", draft: "b".repeat(32), patch: { accountId: "b".repeat(32) } },
  { label: "AI Gateway", draft: "-mouse", patch: { gatewayId: "-mousedefault" } },
  { label: "BYOK alias", draft: "mouse-key", patch: { byokAlias: "mouse-key" } },
  { label: "Tool exposure", draft: undefined, patch: { exposure: "direct" } },
  { label: "Default result limit", draft: undefined, patch: { limit: 6 } },
  { label: "Request timeout (ms)", draft: undefined, patch: { timeoutMs: 60000 } },
];
test.each([40, 80, 120].flatMap((width) => mouseRows.map((row) => ({ ...row, width }))))(
  "mouse activates only $label at width $width",
  async ({ label, draft, patch, width }) => {
    const h = mouseHarness();
    await h.mount();
    try {
      const lines = h.host.render(width);
      const y = lines.findIndex((line) => line.includes(label));
      assert.ok(y >= 0);
      const press = h.host.handleMouse(mouseEvent("press", width, lines.length, y));
      assert.equal(press?.handled, true);
      assert.equal(press?.focusTarget, h.screen); // Keep root hard-cancel and paste handling.
      h.host.handleMouse(mouseEvent("click", width, lines.length, y));
      if (draft !== undefined) {
        h.screen.handleInput?.(draft);
        h.screen.handleInput?.("\r");
      }
      await h.changed;
      assert.deepEqual(h.patches, [patch]);
    } finally {
      await h.close();
    }
  },
);

test("mouse ignores unrendered, read-only, out-of-bounds and disposed surfaces", async () => {
  const h = mouseHarness();
  await h.mount();
  try {
    assert.equal(h.screen.handleMouse?.(mouseEvent("click", 80, 100, 0)), undefined);
    const width = 40;
    const lines = h.host.render(width);
    const first = lines.findIndex((line) => line.includes("Cloudflare account ID"));
    for (let y = 0; y < first; y++) {
      assert.equal(h.host.handleMouse(mouseEvent("press", width, lines.length, y)), undefined);
      assert.equal(h.host.handleMouse(mouseEvent("click", width, lines.length, y)), undefined);
    }
    for (const y of [-1, lines.length])
      assert.equal(h.host.handleMouse(mouseEvent("click", width, lines.length, y)), undefined);
    for (const type of ["move", "drag", "release"] as const)
      assert.equal(h.host.handleMouse(mouseEvent(type, width, lines.length, first)), undefined);
    assert.equal(
      h.host.handleMouse({ ...mouseEvent("press", width, lines.length, first), button: "right" }),
      undefined,
    );
    const footer = lines.findIndex((line) => line.includes("Enter/Space"));
    assert.ok(footer >= 0);
    assert.equal(h.host.handleMouse(mouseEvent("click", width, lines.length, footer)), undefined);
    h.screen.dispose?.();
    assert.equal(h.host.handleMouse(mouseEvent("click", width, lines.length, first + 3)), undefined);
    assert.deepEqual(h.patches, []);
  } finally {
    h.finish();
    await h.running;
  }
});

test("mouse uses resized wrapped geometry and native wheel navigation", async () => {
  const h = mouseHarness();
  await h.mount();
  try {
    h.host.render(120);
    const width = 40;
    const lines = h.host.render(width);
    const first = lines.findIndex((line) => line.includes("Cloudflare account ID"));
    const wheel = h.host.handleMouse({
      ...mouseEvent("wheel", width, lines.length, first),
      button: "none",
      wheelDelta: 1,
    });
    assert.equal(wheel?.handled, true);
    assert.equal(wheel?.render, true);
    assert.deepEqual(h.patches, []);
    const updated = h.host.render(width);
    const last = updated.findIndex((line) => line.includes("Request timeout (ms)"));
    h.host.handleMouse(mouseEvent("press", width, updated.length, last));
    h.host.handleMouse(mouseEvent("click", width, updated.length, last));
    await h.changed;
    assert.deepEqual(h.patches, [{ timeoutMs: 60000 }]);
  } finally {
    await h.close();
  }
});

test("submenu mouse coordinates preserve native Input cursor placement and root focus", async () => {
  const h = mouseHarness();
  await h.mount();
  try {
    const width = 80;
    const lines = h.host.render(width);
    const row = lines.findIndex((line) => line.includes("AI Gateway"));
    h.host.handleMouse(mouseEvent("press", width, lines.length, row));
    h.host.handleMouse(mouseEvent("click", width, lines.length, row));
    h.screen.handleInput?.("\u0005"); // Move to end first, then mouse back to the start.
    const editor = h.host.render(width);
    const y = editor.findIndex((line) => line.includes("default"));
    assert.ok(y >= 0);
    const result = h.host.handleMouse(mouseEvent("press", width, editor.length, y, 2));
    assert.equal(result?.handled, true);
    assert.equal(result?.focusTarget, h.screen);
    h.screen.handleInput?.("z");
    h.screen.handleInput?.("\r");
    await h.changed;
    assert.deepEqual(h.patches, [{ gatewayId: "zdefault" }]);
  } finally {
    await h.close();
  }
});

test("sanitized cursor-free draft preview does not move the hidden Input cursor", async () => {
  const h = mouseHarness();
  await h.mount();
  try {
    h.screen.handleInput?.("\r");
    h.screen.handleInput?.("\u001b[200~\u0003a\u001b[201~");
    const width = 80;
    const lines = h.host.render(width);
    const y = lines.findIndex((line) => line.includes("Invalid characters:"));
    assert.ok(y >= 0);
    assert.equal(h.host.handleMouse(mouseEvent("press", width, lines.length, y, 0)), undefined);
    h.screen.handleInput?.("\u007f");
    h.screen.handleInput?.("\r");
    await h.changed;
    assert.deepEqual(h.patches, [{ accountId: "\u0003" }]);
  } finally {
    await h.close();
  }
});
