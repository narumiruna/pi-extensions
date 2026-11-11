import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createEditorStatusPublisher } from "../src/editor-status-publisher.js";
import { EditorStatusWidget } from "../src/editor-status-widget.js";

const theme = { fg: (_role: string, text: string) => text } as Theme;

test("divider summaries stay current while collapsed and keep body data out of the label", () => {
  let summary = "1/4 complete";
  let bodyCalls = 0;
  const widget = new EditorStatusWidget({
    name: "Progress",
    theme,
    get summary() {
      return summary;
    },
    renderBody: () => {
      bodyCalls++;
      return ["task"];
    },
  });
  assert.match(widget.render(60)[0] ?? "", /^─ ▾ Progress · 1\/4 complete ─+$/u);
  widget.setCollapsed(true);
  summary = "⚠ 1 blocked · 2/4 complete";
  const lines = widget.render(60);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^─ ▸ Progress · ⚠ 1 blocked · 2\/4 complete ─+$/u);
  assert.equal(bodyCalls, 1);
  widget.setCollapsed(false);
  assert.equal(widget.render(60)[1], "task");
});

test("summary text is sanitized before width bounds and unnamed frames stay passive", () => {
  const raw = "1\u001b[2J/4\ncomplete\u202e";
  const widget = new EditorStatusWidget({ name: "Progress", summary: raw, theme, renderBody: () => [] });
  assert.match(widget.render(60)[0] ?? "", /^─ ▾ Progress · 1\/4 complete ─+$/u);
  for (const width of [0, 1, 2, 3, 5, 12, 60]) {
    const lines = widget.render(width);
    assert.equal(lines.length, 1);
    assert.equal(visibleWidth(lines[0] ?? ""), width);
  }
  const unnamed = new EditorStatusWidget({
    theme,
    get summary(): string {
      throw new Error("unused summary");
    },
    renderBody: () => ["body"],
  });
  assert.deepEqual(unnamed.render(4), ["────", "body"]);
  assert.equal(raw, "1\u001b[2J/4\ncomplete\u202e");
});

for (const action of ["invalidate", "dispose", "collapse"] as const) {
  test(`summary getter ${action} cannot publish stale geometry`, () => {
    let widget: EditorStatusWidget;
    widget = new EditorStatusWidget({
      name: "Progress",
      theme,
      get summary() {
        if (action === "invalidate") widget.invalidate();
        else if (action === "dispose") widget.dispose();
        else widget.setCollapsed(true);
        return "old";
      },
      renderBody: () => ["body"],
    });
    assert.deepEqual(widget.render(40), []);
  });
}

function fixture(mode: "tui" | "rpc" = "tui") {
  let widget: Component | undefined;
  const snapshots: unknown[] = [];
  const context = {
    mode,
    hasUI: true,
    ui: {
      theme,
      setWidget(_key: string, value: unknown) {
        snapshots.push(value);
        widget = typeof value === "function" ? value({ terminal: { rows: 20 }, requestRender() {} }, theme) : undefined;
      },
    },
  } as unknown as Pick<ExtensionContext, "mode" | "hasUI" | "ui">;
  return { context, snapshots, widget: () => widget };
}

test("publisher summary updates while collapsed and supports meaningful divider-only frames", () => {
  const f = fixture();
  const dimensions: number[][] = [];
  const publisher = createEditorStatusPublisher({
    key: "summary",
    name: "Subagents",
    context: f.context,
    isCurrent: () => true,
    summary: (value: number, width, rows) => {
      dimensions.push([width, rows]);
      return `${value} active`;
    },
    render: (_value, _theme, width) => ["─".repeat(width)],
  });
  publisher.publish(2);
  const widget = f.widget();
  assert.ok(widget);
  assert.match(widget.render(40)[0] ?? "", /Subagents · 2 active/u);
  publisher.setCollapsed(true);
  publisher.publish(3);
  assert.match(widget.render(40)[0] ?? "", /▸ Subagents · 3 active/u);
  assert.deepEqual(dimensions, [
    [40, 20],
    [40, 20],
  ]);
  publisher.dispose();
});

for (const stage of ["render", "summary"] as const) {
  test(`reentrant ${stage} publication cannot mix an old body with a new summary`, () => {
    const f = fixture();
    let publisher: ReturnType<typeof createEditorStatusPublisher<string>>;
    publisher = createEditorStatusPublisher({
      key: "summary",
      name: "Progress",
      context: f.context,
      isCurrent: () => true,
      summary: (value: string) => {
        if (stage === "summary" && value === "old") publisher.publish("new");
        return value;
      },
      render(value, _theme, width) {
        if (stage === "render" && value === "old") publisher.publish("new");
        return ["─".repeat(width), value];
      },
    });
    publisher.publish("old");
    const widget = f.widget();
    assert.ok(widget);
    assert.deepEqual(widget.render(40), []);
    const fresh = widget.render(40);
    assert.match(fresh[0] ?? "", /Progress · new/u);
    assert.equal(fresh[1], "new");
    publisher.dispose();
  });
}

test("RPC keeps standalone lines and does not evaluate the TUI summary", () => {
  const f = fixture("rpc");
  const publisher = createEditorStatusPublisher({
    key: "summary",
    name: "Progress",
    context: f.context,
    isCurrent: () => true,
    summary() {
      throw new Error("TUI only");
    },
    render: (value: string) => [value],
  });
  publisher.publish("Progress · 1/4 complete");
  assert.deepEqual(f.snapshots, [["Progress · 1/4 complete"]]);
  publisher.dispose();
});

test("RPC rejects stale output after reentrant snapshot publication", () => {
  const f = fixture("rpc");
  let publisher: ReturnType<typeof createEditorStatusPublisher<string>>;
  publisher = createEditorStatusPublisher({
    key: "rpc",
    context: f.context,
    isCurrent: () => true,
    render(value: string) {
      if (value === "old") publisher.publish("new");
      return [value];
    },
  });
  publisher.publish("old");
  assert.deepEqual(f.snapshots, [["new"]]);
  publisher.dispose();
});

for (const action of ["dispose", "replace", "throw"] as const) {
  test(`publisher summary ${action} cannot leave stale geometry`, () => {
    const f = fixture();
    let active = true;
    let fail = false;
    let publisher: ReturnType<typeof createEditorStatusPublisher<string>>;
    publisher = createEditorStatusPublisher({
      key: "summary",
      name: "Progress",
      context: f.context,
      isCurrent: () => active,
      summary: () => {
        if (fail) {
          if (action === "dispose") publisher.dispose();
          else if (action === "replace") active = false;
          else throw new Error("summary failed");
        }
        return "current";
      },
      render: (value: string) => ["divider", value],
    });
    publisher.publish("body");
    const widget = f.widget();
    assert.ok(widget);
    assert.equal(widget.render(40).length, 2);
    fail = true;
    if (action === "throw") assert.throws(() => widget.render(40), /summary failed/u);
    else assert.deepEqual(widget.render(40), []);
    publisher.dispose();
  });
}

test("a changed summary cancels a pending gesture without blocking native selection", () => {
  let summary = "before";
  const widget = new EditorStatusWidget({
    name: "Progress",
    get summary() {
      return summary;
    },
    theme,
    renderBody: () => ["body"],
  });
  widget.render(40);
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 39,
    y: 1,
    screenX: 39,
    screenY: 1,
    width: 40,
    height: 2,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.equal(widget.handleMouse(event), undefined);
  summary = "after";
  widget.render(40);
  assert.equal(widget.handleMouse({ ...event, type: "release" }), undefined);
  assert.equal(widget.handleMouse({ ...event, type: "click" }), undefined);
  assert.equal(widget.collapsed, false);
});
