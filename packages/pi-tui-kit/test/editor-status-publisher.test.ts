import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  type Terminal,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createEditorStatusPublisher } from "../src/editor-status-publisher.js";
import { EditorStatusWidget } from "../src/editor-status-widget.js";

type Widget = Component & { dispose?(): void };
type Context = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

class MainHost extends TuiMainScreen {
  flush() {
    this.doRender();
  }
}
class FullscreenHost extends TuiAltScreen {
  flush() {
    this.doRender();
  }
}

function fixture(mode: "regular" | "fullscreen") {
  let width = 40;
  let rows = 20;
  let input: (data: string) => void = () => {};
  const writes: string[] = [];
  const noop = () => {};
  const terminal: Terminal = {
    get columns() {
      return width;
    },
    get rows() {
      return rows;
    },
    kittyProtocolActive: false,
    start(onInput) {
      input = onInput;
    },
    stop: noop,
    drainInput: async () => {},
    write: (data) => writes.push(data),
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
  const host = mode === "regular" ? new MainHost(terminal, false) : new FullscreenHost(terminal, false);
  const widgets = new Map<string, Widget>();
  const container = new Container();
  const editor = new Input();
  const root = new VStack([container, editor]);
  if (host instanceof FullscreenHost) host.setLayoutRoot(root);
  else host.addChild(root);
  host.setFocus(editor);
  const calls: Array<{ key: string; content: unknown; placement?: string }> = [];
  let mounts = 0;
  let disposals = 0;
  let renderRequests = 0;
  let failMount: "before" | "after" | undefined;
  let theme = { fg: (_role: string, text: string) => text } as Theme;
  const context = {
    mode: "tui",
    hasUI: true,
    ui: {
      get theme() {
        return theme;
      },
      setWidget(key, content, options) {
        calls.push({ key, content, placement: options?.placement });
        widgets.get(key)?.dispose?.();
        widgets.delete(key);
        if (content !== undefined) {
          if (failMount === "before") throw new Error("mount failed before factory");
          assert.equal(typeof content, "function");
          const created = (content as Exclude<typeof content, string[]>)(host, theme);
          mounts += 1;
          const dispose = created.dispose?.bind(created);
          created.dispose = () => {
            disposals += 1;
            dispose?.();
          };
          widgets.set(key, created);
          if (failMount === "after") throw new Error("mount failed after factory");
        }
        container.clear();
        for (const widget of widgets.values()) container.addChild(widget);
        host.requestRender();
      },
    },
  } as Context;
  const requestRender = host.requestRender.bind(host);
  host.requestRender = () => {
    renderRequests += 1;
    requestRender();
  };
  host.start();
  host.flush();
  return {
    context,
    host,
    widgets,
    calls,
    writes,
    editor,
    get mounts() {
      return mounts;
    },
    get disposals() {
      return disposals;
    },
    get renderRequests() {
      return renderRequests;
    },
    setTheme(next: Theme) {
      theme = next;
      host.invalidate();
    },
    fail(value: typeof failMount) {
      failMount = value;
    },
    resize(columns: number, nextRows: number) {
      width = columns;
      rows = nextRows;
      host.invalidate();
      host.flush();
    },
    send(data: string) {
      input(data);
      host.flush();
    },
    stop() {
      for (const widget of widgets.values()) widget.dispose?.();
      widgets.clear();
      host.stop();
    },
  };
}

function renderer(snapshot: string, theme: Theme, width: number) {
  return new EditorStatusWidget({ theme, renderBody: () => [snapshot] }).render(width);
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode}: visible updates retain mounts and sibling order; hide/show inserts again`, (t) => {
    const f = fixture(mode);
    t.onTestFinished(() => f.stop());
    const first = createEditorStatusPublisher({
      key: "one",
      context: f.context,
      isCurrent: () => true,
      render: renderer,
    });
    const sibling = createEditorStatusPublisher({
      key: "two",
      context: f.context,
      isCurrent: () => true,
      render: renderer,
    });
    first.publish("before");
    sibling.publish("sibling");
    const original = f.widgets.get("one");
    const requests = f.renderRequests;
    first.publish("after");
    assert.ok(f.renderRequests > requests);
    first.publish("after");
    f.host.flush();
    assert.equal(f.widgets.get("one"), original);
    assert.deepEqual([...f.widgets.keys()], ["one", "two"]);
    assert.deepEqual(original?.render(12), ["─".repeat(12), "after"]);
    assert.equal(f.mounts, 2);
    assert.equal(f.disposals, 0);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(({ placement }) => placement === "aboveEditor"));
    f.send("draft");
    assert.equal(f.editor.getValue(), "draft");
    first.publish(undefined);
    first.publish(undefined);
    assert.deepEqual([...f.widgets.keys()], ["two"]);
    assert.deepEqual(original?.render(12), []);
    first.publish("returned");
    assert.deepEqual([...f.widgets.keys()], ["two", "one"]);
    original?.dispose?.();
    first.publish("still current");
    assert.equal(f.mounts, 3);
    first.dispose();
    first.dispose();
    first.publish("ignored");
    sibling.dispose();
    assert.equal(f.widgets.size, 0);
    assert.deepEqual(
      f.calls.filter(({ content }) => content === undefined).map(({ key }) => key),
      ["one", "one", "two"],
    );
  });

  test(`${mode}: retained render sees immutable latest snapshot, resize and current theme`, (t) => {
    const f = fixture(mode);
    t.onTestFinished(() => f.stop());
    const seen: Array<{ snapshot: readonly string[]; theme: Theme; width: number; rows: number }> = [];
    const publisher = createEditorStatusPublisher<readonly string[]>({
      key: "view",
      context: f.context,
      isCurrent: () => true,
      render(snapshot, theme, width, rows) {
        seen.push({ snapshot, theme, width, rows });
        return renderer(snapshot.join(" "), theme, width);
      },
    });
    const original = Object.freeze(["old"]);
    publisher.publish(original);
    const widget = f.widgets.get("view");
    assert.ok(widget);
    assert.equal(widget.render(40)[1], "old");
    const next = Object.freeze(["界界", "new"]);
    publisher.publish(next);
    const theme = { fg: (_role: string, text: string) => `\u001b[32m${text}\u001b[0m` } as Theme;
    f.setTheme(theme);
    f.resize(5, 9);
    const lines = widget.render(5);
    assert.equal(stripVTControlCharacters(lines[1] ?? ""), "界界 ");
    assert.ok(lines[0]?.includes("\u001b[32m"));
    assert.ok(lines.every((line) => visibleWidth(line) <= 5));
    assert.deepEqual(widget.render(0), ["", ""]);
    assert.deepEqual(original, ["old"]);
    assert.equal(seen.at(-1)?.snapshot, next);
    assert.equal(seen.at(-1)?.theme, theme);
    assert.equal(seen.at(-1)?.rows, 9);
    assert.equal(f.mounts, 1);
    publisher.dispose();
  });
}

test("host disposal invalidates one mount without clearing its later replacement", (t) => {
  const f = fixture("regular");
  t.onTestFinished(() => f.stop());
  const publisher = createEditorStatusPublisher({
    key: "view",
    context: f.context,
    isCurrent: () => true,
    render: renderer,
  });
  publisher.publish("old");
  const old = f.widgets.get("view");
  old?.dispose?.();
  assert.deepEqual(old?.render(20), []);
  publisher.publish("new");
  const replacement = f.widgets.get("view");
  old?.dispose?.();
  assert.equal(f.widgets.get("view"), replacement);
  publisher.publish("latest");
  assert.equal(f.mounts, 2);
  assert.equal(replacement?.render(20)[1], "latest");
  publisher.dispose();
});

for (const failure of ["before", "after"] as const) {
  test(`failed initialization ${failure} factory clears only its key and allows retry`, (t) => {
    const f = fixture("regular");
    t.onTestFinished(() => f.stop());
    const sibling = createEditorStatusPublisher({
      key: "sibling",
      context: f.context,
      isCurrent: () => true,
      render: renderer,
    });
    sibling.publish("keep");
    const publisher = createEditorStatusPublisher({
      key: "failed",
      context: f.context,
      isCurrent: () => true,
      render: renderer,
    });
    f.fail(failure);
    assert.throws(() => publisher.publish("value"), /mount failed/);
    assert.deepEqual([...f.widgets.keys()], ["sibling"]);
    assert.equal(f.calls.at(-1)?.key, "failed");
    assert.equal(f.calls.at(-1)?.content, undefined);
    f.fail(undefined);
    publisher.publish("value");
    assert.equal(f.widgets.get("failed")?.render(20)[1], "value");
    publisher.dispose();
    publisher.dispose();
    sibling.dispose();
  });
}

test("stale owners never read context/UI or render and cannot clear a new owner", (t) => {
  const f = fixture("regular");
  t.onTestFinished(() => f.stop());
  let current = true;
  const publisher = createEditorStatusPublisher({
    key: "view",
    context: f.context,
    isCurrent: () => current,
    render: renderer,
  });
  publisher.publish("old");
  const old = f.widgets.get("view");
  publisher.dispose(); // Ownership transfers only after disposal.
  current = false;
  const replacement = createEditorStatusPublisher({
    key: "view",
    context: f.context,
    isCurrent: () => true,
    render: renderer,
  });
  replacement.publish("new");
  Object.defineProperty(f.context, "ui", {
    get() {
      throw new Error("stale context");
    },
  });
  const calls = f.calls.length;
  publisher.publish("stale");
  publisher.dispose();
  old?.dispose?.();
  assert.deepEqual(old?.render(20), []);
  assert.equal(f.calls.length, calls);
  const inert = createEditorStatusPublisher({
    key: "stale",
    context: f.context,
    isCurrent: () => false,
    render: renderer,
  });
  inert.publish("ignored");
  inert.dispose();
  replacement.dispose();
});

test("loss of ownership rejects pending render, publish and cleanup before UI access", (t) => {
  const f = fixture("regular");
  t.onTestFinished(() => f.stop());
  let current = true;
  const publisher = createEditorStatusPublisher({
    key: "view",
    context: f.context,
    isCurrent: () => current,
    render: renderer,
  });
  publisher.publish("old");
  const widget = f.widgets.get("view");
  current = false;
  Object.defineProperty(f.context.ui, "theme", {
    get() {
      throw new Error("stale UI");
    },
  });
  const calls = f.calls.length;
  assert.deepEqual(widget?.render(20), []);
  publisher.publish("ignored");
  publisher.publish(undefined);
  publisher.dispose();
  assert.equal(f.calls.length, calls);
});

test("RPC publishes full string snapshots at 80 columns and 36 rows, then clears exactly once", () => {
  const calls: Array<{ key: string; content: unknown }> = [];
  let current = true;
  let theme = { fg: (_role: string, text: string) => text } as Theme;
  const context = {
    mode: "rpc",
    hasUI: true,
    ui: {
      get theme() {
        assert.ok(current);
        return theme;
      },
      setWidget(key: string, content: unknown) {
        assert.ok(current);
        assert.ok(content === undefined || Array.isArray(content));
        calls.push({ key, content });
      },
    },
  } as Context;
  const seen: [number, number][] = [];
  const publisher = createEditorStatusPublisher({
    key: "rpc:view",
    context,
    isCurrent: () => current,
    render(snapshot: string, activeTheme, width, rows) {
      seen.push([width, rows]);
      return renderer(snapshot, activeTheme, width);
    },
  });
  publisher.publish("one");
  publisher.publish("one");
  theme = { fg: (_role: string, text: string) => `\u001b[32m${text}\u001b[0m` } as Theme;
  publisher.publish("two");
  const rule = (calls[1]?.content as string[] | undefined)?.[0] ?? "";
  assert.equal(stripVTControlCharacters(rule), "─".repeat(80));
  assert.ok(rule.includes("\u001b[32m"));
  assert.deepEqual(seen, [
    [80, 36],
    [80, 36],
  ]);
  publisher.publish(undefined);
  publisher.publish(undefined);
  publisher.publish("three");
  publisher.dispose();
  publisher.dispose();
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ key }) => key === "rpc:view"));
  current = false;
  publisher.publish("ignored");
});

test("RPC publication failures clear only the owned key and allow the same snapshot to retry", () => {
  const calls: Array<{ key: string; content: unknown }> = [];
  let fail = true;
  const context = {
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: { fg: (_role: string, text: string) => text },
      setWidget(key: string, content: unknown) {
        calls.push({ key, content });
        if (fail) throw new Error(content === undefined ? "cleanup failed" : "publication failed");
      },
    },
  } as Context;
  const publisher = createEditorStatusPublisher({ key: "rpc:view", context, isCurrent: () => true, render: renderer });
  assert.throws(
    () => publisher.publish("snapshot"),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((cause: Error) => cause.message),
        ["publication failed", "cleanup failed"],
      );
      return true;
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.content, undefined);
  fail = false;
  publisher.publish("snapshot");
  assert.equal(calls.length, 3);
  assert.ok(Array.isArray(calls[2]?.content));
  publisher.dispose();
  publisher.dispose();
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ key }) => key === "rpc:view"));
});

for (const action of ["hide", "dispose"] as const) {
  test(`${action}: cleanup failure invalidates the old component and repeated cleanup is safe`, (t) => {
    const f = fixture("regular");
    t.onTestFinished(() => f.stop());
    const publisher = createEditorStatusPublisher({
      key: "view",
      context: f.context,
      isCurrent: () => true,
      render: renderer,
    });
    publisher.publish("snapshot");
    const old = f.widgets.get("view");
    const original = f.context.ui.setWidget.bind(f.context.ui);
    let clears = 0;
    let fail = true;
    f.context.ui.setWidget = ((key, content) => {
      if (content === undefined) {
        clears += 1;
        if (fail) throw new Error("cleanup failed");
      }
      if (Array.isArray(content)) original(key, content);
      else original(key, content);
    }) as Context["ui"]["setWidget"];
    assert.throws(() => (action === "hide" ? publisher.publish(undefined) : publisher.dispose()), /cleanup failed/);
    assert.deepEqual(old?.render(20), []);
    fail = false;
    if (action === "hide") publisher.publish(undefined);
    else publisher.dispose();
    publisher.dispose();
    publisher.dispose();
    assert.equal(clears, 2);
    assert.equal(f.widgets.has("view"), false);
  });
}

test("RPC disposal retries a failed clear without republishing stale content", () => {
  let shown: unknown;
  let fail = false;
  const context = {
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: { fg: (_role: string, text: string) => text },
      setWidget(_key: string, content: unknown) {
        if (content === undefined && fail) throw new Error("clear failed");
        shown = content;
      },
    },
  } as Context;
  const publisher = createEditorStatusPublisher({ key: "rpc", context, isCurrent: () => true, render: renderer });
  publisher.publish("old");
  fail = true;
  assert.throws(() => publisher.dispose(), /clear failed/u);
  fail = false;
  publisher.publish("must not return");
  publisher.dispose();
  publisher.dispose();
  assert.equal(shown, undefined);
});

for (const mode of ["print", "json", "tui", "rpc"] as const) {
  test(`${mode}: headless publisher acquires no UI resources`, () => {
    const context = {
      mode,
      hasUI: false,
      get ui(): Context["ui"] {
        throw new Error("no UI access");
      },
    };
    const publisher = createEditorStatusPublisher({
      key: "none",
      context,
      isCurrent: () => true,
      render() {
        throw new Error("no render");
      },
    });
    publisher.publish("ignored");
    publisher.publish(undefined);
    publisher.dispose();
    publisher.dispose();
  });
}
