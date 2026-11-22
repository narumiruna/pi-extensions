import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type SettingItem, SettingsList, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { renderBoundedFrameLayout } from "../src/bounded-frame.js";
import { runCustomInteraction } from "../src/custom-interaction.js";
import { createFramedSettingsMouseRouter } from "../src/framed-settings-mouse.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

const identity = (text: string) => text;

function createList(
  items: SettingItem[] = ["First", "Second", "Third"].map((label) => ({
    id: label,
    label,
    currentValue: "off",
    values: ["off", "on"],
  })),
) {
  const changes: [string, string][] = [];
  const dispatched: TuiMouseEvent[] = [];
  const list = new SettingsList(
    items,
    items.length,
    { label: identity, value: identity, description: identity, cursor: "→", hint: identity },
    (id, value) => changes.push([id, value]),
    () => {},
  );
  const router = createFramedSettingsMouseRouter((event) => {
    dispatched.push(event);
    return list.handleMouse(event);
  });
  const paint = (width = 32, maxRows = 12, grouped = false) => {
    const native = list.render(Math.max(4, width));
    const content = grouped ? ["Group heading", ...native] : native;
    const focused = content.findIndex((row) => row.startsWith("→"));
    const frame = renderBoundedFrameLayout({
      width,
      maxRows,
      rule: "─".repeat(width),
      title: ["Settings"],
      content,
      priorityRows: [focused],
      focusedRow: focused,
    });
    router.setLayout({
      width,
      nativeHeight: native.length,
      rows: grouped
        ? frame.contentRows.flatMap(({ frameIndex, contentIndex }) =>
            contentIndex === 0 ? [] : [{ frameIndex, contentIndex: contentIndex - 1 }],
          )
        : frame.contentRows,
    });
    return frame.lines;
  };
  return { changes, dispatched, list, paint, router };
}

function mouse(type: TuiMouseEvent["type"], y: number, options: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type,
    button: "left",
    x: 1,
    y,
    width: 32,
    height: 12,
    screenX: 3,
    screenY: y + 10,
    shift: false,
    alt: false,
    ctrl: false,
    ...options,
  };
}

function row(lines: readonly string[], label: string) {
  const index = lines.findIndex((line) => line.includes(label));
  assert.ok(index >= 0, `Missing ${label}`);
  return index;
}

test("keeps a handled press across layout publication and returns native mouse results", () => {
  const { paint, router, dispatched, changes, list } = createList();
  const height = list.render(32).length;
  const press = mouse("press", row(paint(), "Second"));
  assert.deepEqual(router.handleMouse(press), { handled: true, focus: true });
  const click = mouse("click", row(paint(), "Second"), { clickCount: 2 });
  assert.deepEqual(router.handleMouse(click), { handled: true });
  assert.deepEqual(changes, [["Second", "on"]]);
  assert.deepEqual(dispatched, [
    { ...press, y: 1, height },
    { ...click, y: 1, height },
  ]);
});

test.each(["outside click", "outside press", "clear", "wheel"] as const)(
  "replaces a stale native press after %s",
  (reset) => {
    const { paint, router, dispatched, changes } = createList();
    router.handleMouse(mouse("press", row(paint(), "First")));
    const next = paint();
    if (reset === "clear") {
      router.clear();
      assert.equal(router.handleMouse(mouse("click", row(next, "Third"))), undefined);
      paint();
    } else if (reset === "wheel") {
      assert.deepEqual(router.handleMouse(mouse("wheel", row(next, "First"), { button: "none", wheelDelta: 1 })), {
        handled: true,
        render: true,
      });
    } else {
      assert.equal(router.handleMouse(mouse(reset === "outside click" ? "click" : "press", 0)), undefined);
    }
    assert.deepEqual(changes, []);
    router.handleMouse(mouse("click", row(paint(), "Third")));
    assert.deepEqual(changes, [["Third", "on"]]);
    assert.deepEqual(
      dispatched.slice(-2).map(({ type, y }) => [type, y]),
      [
        ["press", 2],
        ["click", 2],
      ],
    );
  },
);

test("routes retained native rows after grouping and clipping but ignores unmapped or out-of-width events", () => {
  const { paint, router, changes, dispatched, list } = createList();
  const full = paint(32, 12, true);
  for (const y of [0, row(full, "Settings"), row(full, "Group heading"), full.length - 1]) {
    assert.equal(router.handleMouse(mouse("click", y)), undefined);
  }
  const first = row(full, "First");
  assert.equal(router.handleMouse(mouse("click", first, { x: 32 })), undefined);
  assert.deepEqual(dispatched, []);
  assert.equal(router.handleMouse(mouse("move", first)), undefined);
  assert.equal(router.handleMouse(mouse("click", first, { button: "right" })), undefined);
  assert.deepEqual(changes, []);

  list.selectItem("Third");
  paint(0, 1, true);
  assert.equal(router.handleMouse(mouse("click", 0, { x: 0 })), undefined);
  const narrow = paint(1, 1, true);
  assert.deepEqual(narrow.map(stripVTControlCharacters), ["→"]);
  const nativeHeight = list.render(4).length;
  assert.deepEqual(router.handleMouse(mouse("click", 0, { x: 0 })), { handled: true });
  assert.deepEqual(changes, [["Third", "on"]]);
  assert.deepEqual(
    dispatched.slice(-2).map(({ y, width, height }) => [y, width, height]),
    [
      [2, 1, nativeHeight],
      [2, 1, nativeHeight],
    ],
  );
});

test("leaves native submenu activation and mouse delegation intact", () => {
  const events: TuiMouseEvent[] = [];
  const { paint, router, changes, dispatched } = createList([
    {
      id: "limit",
      label: "Limit",
      currentValue: "none",
      submenu: (_current, done) => ({
        render: () => ["Choose a limit"],
        invalidate() {},
        handleMouse(event) {
          events.push(event);
          if (event.type === "click") done("10");
          return { handled: true, render: false };
        },
      }),
    },
  ]);
  router.handleMouse(mouse("click", row(paint(), "Limit")));
  assert.deepEqual(changes, []);
  const y = row(paint(), "Choose a limit");
  assert.deepEqual(router.handleMouse(mouse("click", y)), { handled: true, render: false, focus: true });
  assert.deepEqual(changes, [["limit", "10"]]);
  assert.deepEqual(events, dispatched.slice(-2));
  assert.deepEqual(
    events.map(({ type, y, height }) => [type, y, height]),
    [
      ["press", 0, 1],
      ["click", 0, 1],
    ],
  );
});

test("fullscreen renderer delivers press, redraw and synthesized click without an extra press", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme(), { rows: 30 });
  t.onTestFinished(() => fixture.stop());
  const { router, paint, list, changes, dispatched } = createList();
  let painted: readonly string[] = [];
  let renderCount = 0;
  const running = runCustomInteraction(fixture.ctx, {
    create: () => ({
      render(width) {
        renderCount++;
        painted = paint(width);
        return painted;
      },
      invalidate() {
        router.clear();
        list.invalidate();
      },
      handleMouse: router.handleMouse,
    }),
  });
  await fixture.waitForOpen();
  const screenRow = (label: string) => 30 - painted.length + row(painted, label) + 1;
  const y = screenRow("Second");
  const before = renderCount;
  fixture.send(`\x1b[<0;2;${y}M`);
  assert.ok(renderCount > before);
  assert.deepEqual(changes, []);
  fixture.send(`\x1b[<0;2;${y}m`);
  assert.deepEqual(
    dispatched.map(({ type }) => type),
    ["press", "release", "click"],
  );
  assert.deepEqual(changes, [["Second", "on"]]);

  fixture.send(`\x1b[<0;2;${screenRow("First")}M`);
  fixture.send("\x1b[<0;2;2m");
  assert.deepEqual(changes, [["Second", "on"]]);
  const third = screenRow("Third");
  fixture.send(`\x1b[<0;2;${third}M`);
  fixture.send(`\x1b[<0;2;${third}m`);
  assert.deepEqual(changes, [
    ["Second", "on"],
    ["Third", "on"],
  ]);
  fixture.close();
  await running;
});
