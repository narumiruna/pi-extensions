import type { Component } from "@earendil-works/pi-tui";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  captureWidgetLines,
  escapedCaptureSource,
  runCopyCaptureShowcase,
  SYNTHETIC_COPY_SECOND_SOURCE,
  SYNTHETIC_COPY_SOURCE,
} from "../scripts/showcase/copy-demo.js";

const KEY = "tui-kit-showcase:copy-capture";
const widgetTheme = { fg: (_role: string, text: string) => text };
const optionsFor = (owner: AbortController) => ({ signal: owner.signal, isCurrent: () => !owner.signal.aborted });

function copyKeys() {
  return new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.message.copy": { defaultKeys: ["ctrl+x"], description: "Synthetic in-memory capture" },
  });
}

function renderCapture(widgets: Map<string, unknown>, width = 120): string[] {
  const factory = widgets.get(KEY) as ((_tui: unknown, theme: typeof widgetTheme) => Component) | undefined;
  return factory?.(undefined, widgetTheme).render(width) ?? [];
}

test("capture inspection is ASCII JSON and preserves every raw source code unit", () => {
  const raw = `${SYNTHETIC_COPY_SOURCE}\u007f\u009b\u202e\u2028🙂\ud800`;
  const encoded = escapedCaptureSource(raw);
  expect(encoded).toMatch(/^[\x20-\x7e]*$/u);
  expect(JSON.parse(encoded)).toBe(raw);
  expect(encoded).toContain("\\r\\n\\t");
  expect(encoded).toContain("  \\r\\n");
  expect(encoded).toContain("\\u202e");
  expect(encoded).toContain("\\u2028");
  expect(encoded).toContain("\\ud83d\\ude42\\ud800");
  const normal = captureWidgetLines(raw, "raw-a", 120);
  expect(normal.length).toBeLessThanOrEqual(6);
  expect(normal[0]).toContain("Complete exact JSON");
  const narrow = captureWidgetLines(raw, "raw-a", 1);
  expect(narrow[0]).toContain("! CLIPPED");
  expect(narrow.length).toBeLessThanOrEqual(6);
  expect(captureWidgetLines(raw, undefined, 0)).toEqual([]);
});

test.each(["review", "browse", "standalone"] as const)(
  "%s captures exact source in place after failure, repeats, and cleans its widget",
  async (route) => {
    const tui = createTuiHarness({ width: 100, rows: 30, keybindings: copyKeys() });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    context.widgets.set("unrelated:widget", "keep");
    const owner = new AbortController();
    const pending = runCopyCaptureShowcase(context.ctx, optionsFor(owner));
    await tui.waitForOpen();
    const routeIndex = route === "review" ? 0 : route === "browse" ? 1 : 2;
    for (let index = 0; index < routeIndex; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    if (route === "browse") {
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
    }
    tui.send("\u0018");
    await tui.waitForPending();
    const failed = tui.render().join("\n");
    const before = renderCapture(context.widgets).join("\n");
    tui.send("\u0018");
    await tui.waitForPending();
    const copied = tui.render().join("\n");
    const captured = renderCapture(context.widgets);
    tui.send("\u0018");
    await tui.waitForPending();
    const repeated = renderCapture(context.widgets);
    const openAfterCopy = tui.isOpen;
    owner.abort();
    await pending;

    const source = route === "browse" ? SYNTHETIC_COPY_SECOND_SOURCE : SYNTHETIC_COPY_SOURCE;
    expect(failed).toMatch(/Copy failed; try\s+again/u);
    expect(before).toContain("First capture fails intentionally");
    expect(copied).toContain("Copied");
    if (route === "review") expect(copied).toContain("Acknowledgements: 0");
    expect(captured.join("\n")).toContain(escapedCaptureSource(source));
    expect(captured.join("\n")).toContain(route === "browse" ? 'Captured "raw-b"' : "Captured review");
    expect(repeated).toEqual(captured);
    expect(openAfterCopy).toBe(true);
    expect(captured.every((line) => visibleWidth(line) <= 120)).toBe(true);
    expect(captured).toHaveLength(4);
    expect(context.widgets.get(KEY)).toBeUndefined();
    expect(context.widgets.get("unrelated:widget")).toBe("keep");
    expect(context.notifications).toEqual([]);
  },
);

test("accepted capture cannot republish its widget after owner abort", async () => {
  const tui = createTuiHarness({ keybindings: copyKeys() });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const owner = new AbortController();
  const pending = runCopyCaptureShowcase(context.ctx, optionsFor(owner));
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  tui.send("\u0018");
  await tui.waitForPending();
  tui.send("\u0018");
  owner.abort();
  await pending;
  expect(context.widgets.get(KEY)).toBeUndefined();
  expect(context.notifications).toEqual([]);
});

test.each(["close", "dispose", "abort"] as const)("copy showcase %s clears only its owned widget", async (ending) => {
  const tui = createTuiHarness({ keybindings: copyKeys() });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  context.widgets.set("unrelated:widget", "keep");
  const owner = new AbortController();
  const pending = runCopyCaptureShowcase(context.ctx, optionsFor(owner));
  await tui.waitForOpen();
  if (ending === "close") tui.press("ctrl+c");
  else if (ending === "dispose") tui.dispose();
  else owner.abort();
  await pending;
  expect(context.widgets.get(KEY)).toBeUndefined();
  expect(context.widgets.get("unrelated:widget")).toBe("keep");
});

test.each(["rpc", "print", "json"] as const)("copy capture never mounts a widget or invokes UI in %s", async (mode) => {
  let customCalls = 0;
  const context = createMockContext({
    mode,
    hasUI: mode === "rpc",
    custom: async () => {
      customCalls += 1;
    },
  });
  await runCopyCaptureShowcase(context.ctx, optionsFor(new AbortController()));
  expect(customCalls).toBe(0);
  expect(context.widgets.size).toBe(0);
  expect(context.notifications).toEqual([]);
});
