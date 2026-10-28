import assert from "node:assert/strict";
import { setImmediate as nextInputCycle } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runDocumentReview } from "../src/document-review.js";
import { defineMenu } from "../src/model.js";
import { runMenu } from "../src/runtime.js";
import { createRpcHarness, createTuiHarness } from "../src/testing/index.js";
import type { TuiHarnessOptions } from "../src/testing/types.js";
import type { DocumentCopyContext, ReviewScreen } from "../src/types.js";
import { documentComponent, documentKeys } from "./fixtures/document-copy.js";
import { deferred } from "./fixtures/renderer-host.js";

function tuiHarness() {
  return createTuiHarness({ keybindings: documentKeys() as TuiHarnessOptions["keybindings"] });
}

for (const operation of ["close", "back", "confirm", "dispose", "session replacement", "shutdown"] as const) {
  test(`copy aborts and drains on ${operation} without late rendering`, async () => {
    const owner = new AbortController();
    const gate = deferred<void>();
    let context: DocumentCopyContext | undefined;
    let disposed = 0;
    const harness = documentComponent(
      {
        kind: "review",
        title: "Review",
        content: "private source",
        confirm: { id: "apply", label: "Apply", action: "apply" },
        copy: {
          label: "Copy",
          onCopy: (accepted) => {
            context = accepted;
            return gate.promise;
          },
        },
      },
      { signal: owner.signal, onDispose: () => disposed++ },
    );
    harness.component.handleInput("\u0018");
    if (operation === "close") harness.component.handleInput("\u0003");
    else if (operation === "back") harness.component.handleInput("\u001b");
    else if (operation === "confirm") harness.component.handleInput("\r");
    else if (operation === "dispose") harness.component.dispose?.();
    else owner.abort(new DOMException(operation, "AbortError"));
    assert.equal(context?.signal.aborted, true);
    let drained = false;
    const draining = harness.component.waitForPending().then(() => {
      drained = true;
    });
    await nextInputCycle();
    assert.equal(drained, false, "accepted non-cancellable work is still owned");
    const before = harness.renders;
    gate.reject({ source: "private source" });
    await draining;
    assert.equal(harness.renders, before);
    assert.ok(!harness.text().includes("Copy failed"));
    harness.component.dispose?.();
    harness.component.dispose?.();
    assert.equal(disposed, 1);
  });
}

test("copy cancellation releases work that honors the signal and drains its rejection", async () => {
  const owner = new AbortController();
  let released = 0;
  const harness = documentComponent(
    {
      kind: "review",
      title: "Review",
      content: "body",
      copy: {
        label: "Copy",
        onCopy: ({ signal }) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                released++;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      },
    },
    { signal: owner.signal },
  );
  harness.component.handleInput("\u0018");
  owner.abort();
  await harness.component.waitForPending();
  assert.equal(released, 1);
  harness.component.dispose?.();
  assert.equal(released, 1);
});

for (const runner of ["standalone", "menu"] as const) {
  for (const ending of ["close", "dispose", "replacement", "shutdown", "stale owner"] as const) {
    test(`${runner} drains an accepted copy before returning after ${ending}`, async () => {
      const gate = deferred<void>();
      const owner = new AbortController();
      const tui = tuiHarness();
      const fixture = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
      let current = true;
      let accepted: DocumentCopyContext | undefined;
      const screen: ReviewScreen<"apply"> = {
        kind: "review",
        title: "Review",
        content: "private source",
        hint: "close",
        copy: {
          label: "Copy",
          onCopy: (context) => {
            accepted = context;
            return gate.promise;
          },
        },
      };
      const options = { signal: owner.signal, isCurrent: () => current };
      const running =
        runner === "standalone"
          ? runDocumentReview(fixture.ctx, { ...screen, ...options })
          : runMenu(
              fixture.ctx,
              defineMenu({
                start: "review",
                screens: { review: () => screen },
                actions: { apply: () => ({ kind: "close" }) },
              }),
              {
                ...options,
                getState: () => undefined,
              },
            );
      await tui.waitForOpen();
      tui.send("\u0018");
      assert.equal(accepted?.content, "private source");
      let settled = false;
      void running.then(() => {
        settled = true;
      });
      if (ending === "close") tui.send("\u0003");
      else if (ending === "dispose") tui.dispose();
      else if (ending === "stale owner") {
        current = false;
        tui.dispose();
      } else owner.abort(new DOMException(ending, "AbortError"));
      await nextInputCycle();
      const earlySettlement = settled;
      const aborted = accepted?.signal.aborted;
      const before = tui.requestRenderCount;
      gate.reject({ source: "private source", message: "private source" });
      const result = await running;
      assert.equal(earlySettlement, false);
      assert.equal(aborted, true);
      assert.equal(tui.requestRenderCount, before);
      if (ending === "close")
        assert.deepEqual(
          result,
          runner === "standalone" ? { kind: "cancelled", reason: "close" } : { kind: "closed", reason: "close" },
        );
      else if (ending === "dispose" && runner === "menu") assert.deepEqual(result, { kind: "closed", reason: "close" });
      else assert.deepEqual(result, { kind: "stale" });
      assert.deepEqual(fixture.notifications, []);
    });
  }
}

test("menu cancels then drains Copy even when a custom host resolves without component disposal", async () => {
  const gate = deferred<void>();
  const tui = tuiHarness();
  let copySignal: AbortSignal | undefined;
  const custom: ExtensionContext["ui"]["custom"] = (factory, options) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      return {
        render: (width) => component.render(width),
        invalidate: () => component.invalidate(),
        handleInput: (data) => component.handleInput?.(data),
      };
    }, options);
  const fixture = createMockContext({ mode: "tui", hasUI: true, custom });
  const running = runMenu(
    fixture.ctx,
    defineMenu({
      start: "review",
      actions: {},
      screens: {
        review: () => ({
          kind: "review",
          title: "Review",
          content: "body",
          copy: {
            label: "Copy",
            onCopy: ({ signal }) => {
              copySignal = signal;
              return gate.promise;
            },
          },
        }),
      },
    }),
    { getState: () => undefined },
  );
  await tui.waitForOpen();
  tui.send("\u0018");
  tui.dispose();
  await nextInputCycle();
  assert.equal(copySignal?.aborted, true);
  gate.resolve();
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

for (const runner of ["standalone", "menu review", "browse detail"] as const) {
  test(`${runner} RPC pagination and confirmation do not offer or invoke Copy`, async () => {
    let copies = 0;
    const copy = {
      label: "Copy source",
      onCopy: () => {
        copies++;
        throw new Error("clipboard must not run");
      },
    };
    const content = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const rpc = createRpcHarness(
      runner === "browse detail"
        ? [
            { kind: "select", response: "Schema" },
            { kind: "select", response: "Next" },
            { kind: "select", response: "Back" },
            { kind: "select", response: "Done" },
          ]
        : [
            { kind: "select", response: "Next" },
            { kind: "select", response: "Apply" },
          ],
    );
    const fixture = createMockContext({ mode: "rpc", hasUI: true, select: rpc.ui.select });
    let confirmed = 0;
    const screen: ReviewScreen<"apply"> = {
      kind: "review",
      title: "Review",
      content,
      viewportSize: 4,
      copy,
      confirm: { id: "apply", label: "Apply", action: "apply" },
    };
    const result =
      runner === "standalone"
        ? await runDocumentReview(fixture.ctx, { ...screen, confirmation: { label: "Apply" } })
        : await runMenu(
            fixture.ctx,
            defineMenu({
              start: "document",
              actions: {
                apply: () => {
                  confirmed++;
                  return { kind: "close" };
                },
              },
              screens: {
                document: () =>
                  runner === "browse detail"
                    ? {
                        kind: "browse",
                        title: "Tools",
                        hint: "close",
                        items: [{ id: "raw-id", label: "Schema", detailDocument: { content, copy } }],
                      }
                    : screen,
              },
            }),
            { getState: () => undefined },
          );
    assert.deepEqual(result, runner === "standalone" ? { kind: "confirmed" } : { kind: "closed", reason: "close" });
    assert.equal(copies, 0);
    assert.equal(confirmed, runner === "menu review" ? 1 : 0);
    assert.ok(rpc.dialogs.every((dialog) => !JSON.stringify(dialog).includes("Copy source")));
    assert.ok(!JSON.stringify(rpc.dialogs).includes("\\u001b]52;"));
    rpc.assertConsumed();
  });
}

for (const mode of ["print", "json"] as const) {
  test(`copy-configured ${mode} remains unsupported without callback or terminal output`, async () => {
    let copies = 0;
    let custom = 0;
    const fixture = createMockContext({
      mode,
      hasUI: false,
      custom: () => {
        custom++;
      },
    });
    const screen: ReviewScreen<"apply"> = {
      kind: "review",
      title: "Review",
      content: "body",
      copy: {
        label: "Copy",
        onCopy: () => {
          copies++;
        },
      },
    };
    assert.deepEqual(await runDocumentReview(fixture.ctx, screen), { kind: "unsupported", mode });
    assert.deepEqual(
      await runMenu(
        fixture.ctx,
        defineMenu({
          start: "review",
          actions: { apply: () => ({ kind: "close" }) },
          screens: { review: () => screen },
        }),
        { getState: () => undefined },
      ),
      { kind: "unsupported", mode },
    );
    assert.equal(copies, 0);
    assert.equal(custom, 0);
    assert.deepEqual(fixture.notifications, []);
  });
}
