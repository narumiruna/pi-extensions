import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DiffReviewPreview } from "@narumitw/pi-sync-daemon";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { ActiveDiffReview, OpenDiffReviewResult } from "../src/daemon/diff-review.js";
import { showSyncDiffReview } from "../src/ui/diff-review.js";
import { installEngineFixtureHost } from "./engine-host.js";

installEngineFixtureHost();
initTheme("dark", false);

function fixture(
  width = 80,
  rows = 24,
  keybindings?: Pick<KeybindingsManager, "getKeys" | "matches">,
  files: ActiveDiffReview["files"] = [
    { id: "one", path: "settings.json", status: "different" },
    { id: "two", path: "skills/\u001b[31mdemo/SKILL.md", status: "remote-only" },
  ],
) {
  const tui = createTuiHarness({ width, rows, keybindings });
  const owner = new AbortController();
  const opening = Promise.withResolvers<OpenDiffReviewResult>();
  const pendingReads: {
    id: string;
    signal?: AbortSignal;
    reply: ReturnType<typeof Promise.withResolvers<DiffReviewPreview>>;
  }[] = [];
  const overlayRequests: boolean[] = [];
  let openSignal: AbortSignal | undefined;
  let releases = 0;
  const review: ActiveDiffReview = {
    kind: "review",
    id: "comparison-id",
    lines: ["Sync setup: home", "2 changed files"],
    files,
    read(id, signal) {
      const reply = Promise.withResolvers<DiffReviewPreview>();
      pendingReads.push({ id, signal, reply });
      return reply.promise;
    },
    async close() {
      releases++;
    },
  };
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) => {
    overlayRequests.push(options?.overlay === true);
    return tui.custom(factory);
  };
  const context = createMockContext({ mode: "tui", custom });
  const running = showSyncDiffReview(
    context.ctx,
    (signal) => {
      openSignal = signal;
      return opening.promise;
    },
    owner.signal,
  );
  let finished = false;
  void running.then(
    () => (finished = true),
    () => (finished = true),
  );
  const render = () => {
    const lines = tui.render();
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    return stripVTControlCharacters(lines.join("\n"));
  };
  return {
    tui,
    owner,
    running,
    opening,
    review,
    pendingReads,
    overlayRequests,
    notifications: context.notifications,
    get openSignal() {
      return openSignal;
    },
    get releases() {
      return releases;
    },
    render,
    async waitForFrame(text: RegExp, signal: AbortSignal) {
      while (!tui.isOpen || !text.test(render())) {
        if (finished) {
          await running;
          assert.fail(`Review closed before reaching ${text}`);
        }
        await setImmediate(undefined, { signal });
      }
    },
    async openList() {
      await tui.waitForOpen();
      opening.resolve(review);
      await tui.resultPromise;
      await tui.waitForOpen();
    },
    async dispose() {
      owner.abort();
      opening.resolve(review);
      for (const read of pendingReads) read.reply.resolve({ kind: "stale" });
      tui.dispose();
      await running;
    },
  };
}

for (const [width, rows] of [
  [80, 24],
  [22, 12],
]) {
  test(`${width}×${rows}: inspect one selected file, keep list filter/selection, and close without logging content`, async (t) => {
    const f = fixture(width, rows);
    t.onTestFinished(() => f.dispose());
    await f.openList();
    assert.match(f.render(), /View differences/u);
    assert.equal(f.pendingReads.length, 0);
    f.tui.type("demo");
    assert.doesNotMatch(f.render(), /settings\.json/u);
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    assert.deepEqual(
      f.pendingReads.map(({ id }) => id),
      ["two"],
    );
    f.pendingReads[0]?.reply.resolve({ kind: "diff", content: "--- Local\n+++ Remote\n@@ -0,0 +1 @@\n+hello world" });
    await f.waitForFrame(/--- Local/u, t.signal);
    f.tui.press("end");
    assert.match(f.render(), /\+hello world/u);
    assert.ok(f.overlayRequests.includes(true));
    if (width < 24) assert.equal(f.overlayRequests.at(-1), false);
    f.tui.press("tui.select.cancel");
    await f.tui.waitForOpen();
    assert.match(f.render(), /demo/u);
    assert.doesNotMatch(f.render(), /settings\.json/u);
    f.tui.press("ctrl+c");
    assert.equal(await f.running, "close");
    assert.equal(f.releases, 1);
    assert.deepEqual(f.notifications, []);
  });
}

test("paths that differ by whitespace stay distinguishable and open the corresponding raw IDs", async (t) => {
  const f = fixture(80, 28, undefined, [
    { id: "one", path: "demo one.txt", status: "different" },
    { id: "two", path: "demo  one.txt", status: "different" },
  ]);
  t.onTestFinished(() => f.dispose());
  await f.openList();
  assert.match(f.render(), /demo one\.txt/u);
  assert.match(f.render(), /demo\\u0020\\u0020one\.txt/u);
  for (const [index, id] of ["one", "two"].entries()) {
    if (index) f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    assert.equal(f.pendingReads[index]?.id, id);
    f.pendingReads[index]?.reply.resolve({ kind: "notice", message: "No text preview" });
    await f.waitForFrame(/No text preview/u, t.signal);
    f.tui.press("tui.select.cancel");
    await f.tui.waitForOpen();
  }
  f.tui.press("ctrl+c");
  assert.equal(await f.running, "close");
  assert.equal(f.releases, 1);
});

for (const hard of [false, true]) {
  test(`${hard ? "Ctrl+C" : "remapped Back"} aborts opening and releases a review delivered during cancellation`, async (t) => {
    const f = fixture(80, 24, {
      getKeys: (id) => (id === "tui.select.cancel" ? ["q"] : []),
      matches: (data, id) => id === "tui.select.cancel" && data === "q",
    });
    t.onTestFinished(() => f.dispose());
    await f.tui.waitForOpen();
    f.tui.send(hard ? "\u0003" : "q");
    assert.equal(f.openSignal?.aborted, true);
    f.opening.resolve(f.review);
    assert.equal(await f.running, hard ? "close" : undefined);
    assert.equal(f.releases, 1);
    assert.equal(f.tui.openCount, 1);
  });
}

test("session replacement drains a pending file read and never opens its obsolete preview", async (t) => {
  const f = fixture();
  t.onTestFinished(() => f.dispose());
  await f.openList();
  f.tui.press("tui.select.confirm");
  await f.tui.waitForOpen();
  f.owner.abort();
  assert.equal(f.pendingReads[0]?.signal?.aborted, true);
  f.pendingReads[0]?.reply.resolve({ kind: "diff", content: "+private stale content" });
  assert.equal(await f.running, "close");
  assert.equal(f.releases, 1);
  assert.deepEqual(f.overlayRequests, [false, false, false]);
  assert.deepEqual(f.notifications, []);
});

test("expired review leaves the comparison with refresh guidance", async (t) => {
  const f = fixture();
  t.onTestFinished(() => f.dispose());
  await f.openList();
  f.tui.press("tui.select.confirm");
  await f.tui.waitForOpen();
  f.pendingReads[0]?.reply.resolve({ kind: "stale" });
  assert.equal(await f.running, undefined);
  assert.equal(f.releases, 1);
  assert.match(f.notifications[0]?.message ?? "", /Reopen View differences/u);
  assert.equal(f.overlayRequests.some(Boolean), false);
});
