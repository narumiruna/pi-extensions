import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { BrowseScreen, DocumentCopyContext, ReviewScreen } from "../src/types.js";
import { documentComponent, documentKeys } from "./fixtures/document-copy.js";
import { deferred } from "./fixtures/renderer-host.js";

const source = `  raw\tvalue  \r\nunsafe\u001b]52;c;source\u0007\u0000\r\n${"offscreen\n".repeat(40)}final  \n`;

for (const format of [{ kind: "text" }, { kind: "code", language: "toml" }, { kind: "markdown" }] as const) {
  test(`review copies original ${format.kind} source, not the displayed or searched document`, async () => {
    const captures: DocumentCopyContext[] = [];
    const screen: ReviewScreen<"apply"> = {
      kind: "review",
      title: "Review",
      content: source,
      format,
      enableSearch: true,
      confirm: { id: "raw-confirm", label: "Apply", action: "apply" },
      copy: {
        label: "Copy raw source",
        onCopy: (context) => {
          captures.push(context);
        },
      },
    };
    const harness = documentComponent(screen);
    const preview = harness.text(160);
    assert.ok(!preview.includes("\u001b]52"));
    assert.match(preview, /ctrl\+x Copy raw source/u);
    harness.component.handleInput(" ");
    harness.component.handleInput("offscreen");
    harness.component.handleInput("\u0018");
    assert.equal(captures.length, 0, "search owns copy keys");
    assert.ok(!harness.text().includes("Copy raw source"));
    harness.component.handleInput("\u001b");
    harness.component.handleInput("\u001b[F");
    harness.component.handleInput("\u0018");
    await harness.component.waitForPending();
    assert.equal(captures.length, 1);
    assert.equal(captures[0]?.content, source);
    assert.equal(captures[0]?.itemId, undefined);
    assert.equal(Object.hasOwn(captures[0] ?? {}, "itemId"), false);
    assert.deepEqual(harness.events, []);
    assert.match(harness.text(), /Copied/u);
    harness.component.handleInput("\r");
    assert.deepEqual(harness.events, [{ kind: "activate", itemId: "raw-confirm" }]);
    harness.component.dispose?.();
  });
}

test("copy snapshots a method without changing its action receiver", async () => {
  const content = "method source";
  const action = {
    label: "Copy source",
    captures: [] as string[],
    onCopy(context: DocumentCopyContext) {
      this.captures.push(context.content);
    },
  };
  const harness = documentComponent({ kind: "review", title: "Review", content, copy: action });
  harness.component.handleInput("\u0018");
  await harness.component.waitForPending();
  assert.deepEqual(action.captures, [content]);
  assert.match(harness.text(), /Copied/u);
  harness.component.dispose?.();
});

test("copy is single-flight, stays readable on failure, never reports callback source, and can retry", async () => {
  const gate = deferred<void>();
  let calls = 0;
  const harness = documentComponent({
    kind: "review",
    title: "Review",
    content: "visible body",
    copy: {
      label: "Copy source",
      onCopy: () => {
        calls++;
        return calls === 1 ? gate.promise : undefined;
      },
    },
  });
  harness.component.handleInput("\u0018");
  for (let index = 0; index < 100; index++) harness.component.handleInput("\u0018");
  assert.equal(calls, 1);
  assert.match(harness.text(), /Copying…/u);
  gate.reject(new Error(source));
  await harness.component.waitForPending();
  assert.match(harness.text(), /visible body[\s\S]*Copy failed; try again/u);
  assert.ok(!harness.text().includes("source\u0007"));
  assert.deepEqual(harness.events, []);
  harness.component.handleInput("\u0018");
  await harness.component.waitForPending();
  assert.equal(calls, 2);
  assert.match(harness.text(), /Copied/u);
  harness.component.dispose?.();
});

test("synchronous copy rejection is safe and does not change confirmation behavior", async () => {
  const harness = documentComponent({
    kind: "review",
    title: "Review",
    content: "body",
    confirm: { id: "apply", label: "Apply", action: "apply" },
    copy: {
      label: "Copy",
      onCopy: () => {
        throw { source, message: source };
      },
    },
  });
  harness.component.handleInput("\u0018");
  await harness.component.waitForPending();
  assert.match(harness.text(), /Copy failed; try again/u);
  assert.deepEqual(harness.events, []);
  harness.component.handleInput("\r");
  assert.deepEqual(harness.events, [{ kind: "activate", itemId: "apply" }]);
  harness.component.dispose?.();
});

test("browse copies the filtered exact document with raw identity and does not infer legacy details", async () => {
  const captures: DocumentCopyContext[] = [];
  const screen: BrowseScreen = {
    kind: "browse",
    title: "Tools",
    enableDetailSearch: true,
    items: [
      { id: "legacy", label: "Legacy", details: ["not exact"] },
      {
        id: "raw\u001b[31m-id\r\n",
        label: "Schema",
        detailDocument: {
          content: source,
          copy: {
            label: "Copy full schema",
            onCopy: (context) => {
              captures.push(context);
            },
          },
        },
      },
    ],
  };
  const harness = documentComponent(screen);
  harness.component.handleInput("\r");
  assert.ok(!harness.text().includes("Copy"));
  harness.component.handleInput("\u0018");
  assert.equal(captures.length, 0);
  harness.component.handleInput("\u001b");
  harness.component.handleInput("Schema");
  harness.component.handleInput("\r");
  harness.component.handleInput(" ");
  harness.component.handleInput("offscreen");
  harness.component.handleInput("\u001b");
  harness.component.handleInput("\u0018");
  await harness.component.waitForPending();
  assert.equal(captures[0]?.content, source);
  assert.equal(captures[0]?.itemId, "raw\u001b[31m-id\r\n");
  assert.match(harness.text(240), /Copied/u);
  assert.deepEqual(harness.events, []);
  harness.component.dispose?.();
});

test("browse Back cancels a pending old-document copy and excludes late feedback from the next document", async () => {
  const gate = deferred<void>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const harness = documentComponent({
    kind: "browse",
    title: "Tools",
    items: [
      {
        id: "a",
        label: "A",
        detailDocument: {
          content: "first",
          copy: {
            label: "Copy A",
            onCopy: (context) => {
              calls++;
              signal = context.signal;
              return gate.promise;
            },
          },
        },
      },
      {
        id: "b",
        label: "B",
        detailDocument: {
          content: "second",
          copy: {
            label: "Copy B",
            onCopy: () => {
              calls++;
            },
          },
        },
      },
    ],
  });
  harness.component.handleInput("\r");
  harness.component.handleInput("\u0018");
  harness.component.handleInput("\u001b");
  assert.equal(signal?.aborted, true);
  harness.component.handleInput("\u001b[B");
  harness.component.handleInput("\r");
  harness.component.handleInput("\u0018");
  assert.equal(calls, 1, "pending work is not queued for the next document");
  const before = harness.renders;
  gate.resolve();
  await harness.component.waitForPending();
  assert.equal(harness.renders, before);
  assert.ok(!harness.text(240).includes("Copied"));
  harness.component.handleInput("\u0018");
  await harness.component.waitForPending();
  assert.equal(calls, 2);
  assert.match(harness.text(240), /Copied/u);
  harness.component.dispose?.();
});

for (const change of ["source", "action", "label", "callback", "owner"] as const) {
  for (const checkpoint of ["render", "settlement"] as const) {
    test(`document ${change} change is revalidated at ${checkpoint} without stale feedback`, async () => {
      const gate = deferred<void>();
      let signal: AbortSignal | undefined;
      let current = true;
      const screen: ReviewScreen<"apply"> = {
        kind: "review",
        title: "Review",
        content: source,
        copy: {
          label: "Copy",
          onCopy: (context) => {
            signal = context.signal;
            return gate.promise;
          },
        },
      };
      const harness = documentComponent(screen, { isCurrent: () => current });
      harness.component.handleInput("\u0018");
      if (change === "source") screen.content = "replacement";
      else if (change === "action") screen.copy = { label: "Different", onCopy() {} };
      else if (change === "label" && screen.copy) screen.copy.label = "Changed label";
      else if (change === "callback" && screen.copy)
        screen.copy.onCopy = () => {
          throw new Error("must not run");
        };
      else current = false;
      if (checkpoint === "render") {
        harness.text();
        assert.equal(signal?.aborted, true);
      }
      const before = harness.renders;
      gate.reject({ source });
      await harness.component.waitForPending();
      assert.equal(signal?.aborted, true);
      assert.equal(harness.renders, before);
      assert.ok(!harness.text().includes("Copy failed"));
      harness.component.dispose?.();
    });
  }
}

for (const change of ["identity", "document"] as const) {
  test(`browse revalidates ${change} after await but keeps the accepted raw snapshot unchanged`, async () => {
    const gate = deferred<void>();
    let captured: DocumentCopyContext | undefined;
    const screen: BrowseScreen = {
      kind: "browse",
      title: "Tools",
      items: [
        {
          id: "raw\u001b[31m-id",
          label: "Schema",
          detailDocument: {
            content: source,
            copy: {
              label: "Copy",
              onCopy: (context) => {
                captured = context;
                return gate.promise;
              },
            },
          },
        },
      ],
    };
    const harness = documentComponent(screen);
    harness.component.handleInput("\r");
    harness.component.handleInput("\u0018");
    const item = screen.items[0];
    assert.ok(item?.detailDocument);
    if (change === "identity") item.id = "replacement";
    else item.detailDocument = { ...item.detailDocument };
    const before = harness.renders;
    gate.resolve();
    await harness.component.waitForPending();
    assert.equal(captured?.content, source);
    assert.equal(captured?.itemId, "raw\u001b[31m-id");
    assert.equal(captured?.signal.aborted, true);
    assert.equal(harness.renders, before);
    assert.ok(!harness.text(240).includes("Copied"));
    harness.component.dispose?.();
  });
}

test("copy labels are display-sanitized and copy feedback stays bounded with native theme roles", async () => {
  const harness = documentComponent({
    kind: "review",
    title: "Review",
    content: source,
    copy: { label: "Copy\u001b]52;c;label\u0007\n source", onCopy() {} },
  });
  harness.component.handleInput("\u0018");
  await harness.component.waitForPending();
  for (const height of [1, 2, 3, 4, 5, 8, 24]) {
    harness.resize(height);
    for (const width of [0, 1, 2, 8, 40, 160]) {
      const lines = harness.component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(!lines.join("\n").includes("\u001b]52"));
      assert.ok(!stripVTControlCharacters(lines.join("\n")).includes("source\u0007"));
    }
    harness.component.invalidate();
  }
  assert.ok(harness.roles.includes("dim"));
  harness.component.dispose?.();
});

test("views without Copy retain byte-identical output across key plans and document searches", () => {
  for (const screen of [
    { kind: "review", title: "Review", content: "body", enableSearch: true },
    { kind: "browse", title: "Tools", items: [{ id: "a", label: "A", detailDocument: { content: "body" } }] },
  ] as const) {
    const standard = documentComponent(screen);
    const configured = documentComponent(screen, { keys: documentKeys(["f12"]) });
    if (screen.kind === "browse") {
      standard.component.handleInput("\r");
      configured.component.handleInput("\r");
    }
    assert.deepEqual(standard.component.render(100), configured.component.render(100));
    standard.component.handleInput("\u0018");
    assert.deepEqual(standard.component.render(100), configured.component.render(100));
    standard.component.dispose?.();
    configured.component.dispose?.();
  }
});
