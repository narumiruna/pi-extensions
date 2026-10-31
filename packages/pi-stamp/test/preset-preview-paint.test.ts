import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  KeybindingsManager,
  ScrollView,
  Spacer,
  type Terminal,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showStampMenu } from "../src/menu.js";
import { METADATA_PRESET_NAMES, type StampMetadataPreset } from "../src/metadata-settings.js";
import { mountedPreviewFixture, RESPONSE_METADATA_ROWS } from "./menu-fixtures.js";

type OwnedComponent = Component & { dispose?(): void };
type NativeMode = "regular" | "fullscreen";
const VISIBLE_METADATA: Record<StampMetadataPreset, RegExp | undefined> = {
  compact: /actual-request|1,110 tok|est \$0\.024/u,
  model: /actual-request/u,
  usage: /1,110/u,
  cost: /est \$0\.024/u,
  abnormal: /stop length/u,
  detailed: /actual-provider|1,110|est \$0\.024/u,
  none: undefined,
};

for (const mode of ["regular", "fullscreen"] as const) {
  for (const [columns, rows] of [
    [80, 24],
    [60, 24],
    [80, 16],
    [60, 16],
  ] as const) {
    test(`${mode} ${columns}x${rows} changes the original timestamp-only Stamp during cursor movement`, async () => {
      const h = await nativeTranscript(mode, columns, rows);
      const before = h.fixture.snapshot();
      const userBefore = h.fixture.components.user?.render(columns);
      const stampBefore = h.fixture.components.assistant?.render(columns);
      const update = vi.spyOn(h.fixture.runtime, "update");
      try {
        await h.open();
        for (const preset of METADATA_PRESET_NAMES) {
          await h.press("\u001b[B");
          assert.ok(h.painted.length > 0, `${preset}: native input must schedule a terminal write`);
          const { transcript, menu } = h.frame();
          const label = `${preset[0]?.toUpperCase()}${preset.slice(1)}`;
          assert.ok(normalize(menu.join(" ")).includes(`→ ${label}`));
          assert.doesNotMatch(menu.join("\n"), /Preview ·|latest assistant|actual-request|tokens in 900|est \$0\.024/u);
          const expectedVisible = VISIBLE_METADATA[preset];
          if (mode === "regular" && rows < 24) {
            // The native picker and Pi chrome can fill a short regular-mode viewport.
            // The original Stamp must still be repainted in terminal scrollback.
            if (expectedVisible) assert.match(normalize(stripVTControlCharacters(h.painted.join(""))), expectedVisible);
          } else if (expectedVisible) assert.match(normalize(transcript.join(" ")), expectedVisible);
          else assert.doesNotMatch(transcript.join("\n"), /actual-|1,110|est \$0\.024|stop length/u);
          const stamp = h.fixture.components.assistant?.render(columns);
          assert.ok(stamp);
          assert.deepEqual(
            stamp
              .slice(1)
              .map((line) => stripVTControlCharacters(line).trim())
              .join(" ")
              .replace(/\s+/gu, " "),
            normalize(RESPONSE_METADATA_ROWS[preset].join(" ")),
          );
          for (const line of stamp) assert.equal(visibleWidth(line), columns, "Stamp must remain right-aligned");
          assert.deepEqual(h.fixture.components.user?.render(columns), userBefore);
          assert.deepEqual(h.fixture.snapshot(), before);
          assert.equal(update.mock.calls.length, 0);
        }
        await h.close();
        assert.deepEqual(h.fixture.components.assistant?.render(columns), stampBefore);
        assert.deepEqual(h.fixture.snapshot(), before);
        assert.deepEqual(h.notifications, []);
      } finally {
        await h.dispose();
      }
    });
  }

  test(`${mode} confirmation keeps the original recovered model row after the preview lease closes`, async () => {
    const h = await nativeTranscript(mode, 80, 24);
    const before = h.fixture.snapshot();
    const update = vi.spyOn(h.fixture.runtime, "update");
    try {
      await h.open();
      await h.press("\u001b[H");
      await h.press("\u001b[B");
      assert.match(h.frame().transcript.join("\n"), /actual-request/u);
      assert.equal(update.mock.calls.length, 0);
      await h.confirm();
      await h.close();
      h.paint();
      assert.match(h.frame().transcript.join("\n"), /actual-request/u);
      assert.doesNotMatch(h.frame().menu.join("\n"), /Preview ·|latest assistant/u);
      const after = h.fixture.snapshot();
      assert.equal(after.state.settings.showRequestedModel, true);
      assert.equal(after.state.settings.showResponseModel, true);
      assert.equal(after.session, before.session);
      assert.equal(after.context, before.context);
      assert.equal(update.mock.calls.length, 1);
      assert.notEqual(after.file, before.file);
    } finally {
      await h.dispose();
    }
  });
}

async function nativeTranscript(mode: NativeMode, columns: number, rows: number) {
  const fixture = await mountedPreviewFixture({}, undefined, { assistantStamp: "timestamp-only" });
  const controller = new AbortController();
  const painted: string[] = [];
  let onInput: ((data: string) => void) | undefined;
  const terminal: Terminal = {
    columns,
    rows,
    kittyProtocolActive: false,
    start(input) {
      onInput = input;
    },
    stop() {},
    async drainInput() {},
    write(data) {
      painted.push(data);
    },
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
  const host = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const document = new Container();
  document.addChild(new Text("hi", 0, 0));
  document.addChild(fixture.components.user as Component);
  document.addChild(new Text("Hi! What can I help you with?", 0, 0));
  document.addChild(fixture.components.assistant as Component);
  const editor = new Container();
  const footer = new Text("footer one\nfooter two", 0, 0);
  const spacer = new Spacer(1);
  if (host instanceof TuiAltScreen) {
    // Pi's native layout retains a flexible transcript above the fixed editor dock.
    const transcript = new ScrollView(document, { follow: "end", primary: true, scrollbar: "hidden" });
    const dock = new VStack([
      spacer,
      { component: editor, shrink: 1, minSize: 3 },
      { component: footer, shrink: 1, minSize: 0 },
    ]);
    host.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
      ]),
    );
  } else {
    for (const component of [document, spacer, editor, footer]) host.addChild(component);
  }
  let openCount = 0;
  let active: OwnedComponent | undefined;
  let completion: Promise<unknown> | undefined;
  const waiters: Array<{ after: number; resolve(value: number): void; reject(error: unknown): void }> = [];
  const waitForOpenAfter = (after: number) => {
    if (active && openCount > after) return Promise.resolve(openCount);
    const pending = Promise.withResolvers<number>();
    waiters.push({ after, resolve: pending.resolve, reject: pending.reject });
    return pending.promise;
  };
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory) => {
    const pending = Promise.withResolvers<never>();
    completion = pending.promise;
    let component: OwnedComponent | undefined;
    let closed = false;
    const done = (value: unknown) => {
      if (closed) return;
      closed = true;
      if (active === component) {
        editor.clear();
        active = undefined;
        host.setFocus(null);
        host.requestRender();
      }
      pending.resolve(value as never);
      component?.dispose?.();
    };
    Promise.resolve(
      factory(
        host,
        {
          fg: (_role: string, text: string) => text,
          bold: (text: string) => text,
        } as never,
        new KeybindingsManager(TUI_KEYBINDINGS) as never,
        done,
      ),
    ).then(
      (created) => {
        component = created;
        if (closed) {
          component.dispose?.();
          return;
        }
        active = component;
        editor.clear();
        editor.addChild(component);
        host.setFocus(component);
        host.requestRender();
        openCount += 1;
        for (const waiter of waiters.splice(0)) {
          if (openCount > waiter.after) waiter.resolve(openCount);
          else waiters.push(waiter);
        }
      },
      (error) => {
        pending.reject(error);
        for (const waiter of waiters.splice(0)) waiter.reject(error);
      },
    );
    return pending.promise;
  };
  const { ctx, notifications } = createMockContext({ mode: "tui", custom, sessionManager: fixture.sessionManager });
  let running: Promise<unknown> | undefined;
  const send = (data: string) => {
    assert.ok(onInput);
    onInput(data);
  };
  return {
    fixture,
    painted,
    notifications,
    paint: () => host.renderNow(),
    frame() {
      const lines = (host instanceof TuiAltScreen ? host.getScreenLines() : host.render(columns).slice(-rows)).map(
        stripVTControlCharacters,
      );
      const border = lines.findIndex((line) => line.startsWith("─"));
      return { transcript: border < 0 ? lines : lines.slice(0, border), menu: border < 0 ? [] : lines.slice(border) };
    },
    async open() {
      host.start();
      running = showStampMenu(ctx, fixture.runtime, {
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
        beginPreview: fixture.display.begin,
      });
      await waitForOpenAfter(0);
      const previous = openCount;
      send("\r");
      await waitForOpenAfter(previous);
      host.renderNow();
    },
    async press(data: string) {
      painted.length = 0;
      send(data);
      // Observe the native scheduled paint; do not force a render after cursor input.
      await new Promise<void>((resolve) => process.nextTick(resolve));
    },
    async confirm() {
      let previous = openCount;
      send("\r");
      while (true) {
        previous = await waitForOpenAfter(previous);
        if (!active) continue;
        if (!active.render(columns).some((line) => line.includes("Saving Stamp preset"))) break;
        await completion;
      }
      host.renderNow();
    },
    async close() {
      send("\u0003");
      await running;
    },
    async dispose() {
      try {
        controller.abort();
        active?.dispose?.();
        await running;
      } finally {
        host.stop();
        fixture.dispose();
      }
    },
  };
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
