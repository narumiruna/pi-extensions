import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { saveReviewedDraft } from "../src/ui/setup/setup-review.js";

const lines = [
  `Sync setup: ${"team-archive-".repeat(8)}`,
  "WebDAV URL: https://cloud.example.com/dav/team/archive/",
  "Remote path: backups/team/settings",
  ...Array.from({ length: 30 }, (_, index) => `Included path ${index}: exact/${index}/settings.json`),
  "Automatic sync: Off",
  "Credentials: stored privately (values hidden)",
  "Saves local settings only. No remote data is changed.",
];

for (const width of [32, 48, 80]) {
  for (const rows of [16, 24]) {
    test(`setup review scrolls exact content at ${width}x${rows} without selectable preview rows`, async () => {
      const tui = createTuiHarness({ width, rows });
      const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
      let saves = 0;
      const pending = saveReviewedDraft(ctx, "Review sync setup", lines, "Save setup", async () => {
        saves++;
      });
      await tui.waitForOpen();
      const frames: string[] = [];
      for (let index = 0; index < 180; index++) {
        const frame = tui.render();
        assert.ok(frame.length <= rows, `${frame.length} > ${rows}`);
        for (const line of frame) assert.ok(visibleWidth(line) <= width);
        frames.push(stripVTControlCharacters(frame.join("\n")));
        tui.press("tui.select.down");
      }
      assert.equal(saves, 0);
      const evidence = frames.join("\n");
      assert.doesNotMatch(evidence, /^\s*→/mu);
      assert.match(evidence, /team-archive/u);
      assert.match(evidence, /Automatic sync: Off/u);
      assert.match(evidence, /Included path 29/u);
      assert.match(evidence, /Save setup/u);
      await expect(`${frames[0]}\n\nScrolled to end:\n${frames.at(-1)}\n`).toMatchFileSnapshot(
        `./fixtures/setup-review-${width}x${rows}.txt`,
      );
      tui.press("tui.select.confirm");
      assert.equal(await pending, true);
      assert.equal(saves, 1);
    });
  }
}

test("a retryable save failure retains the same draft and retries only on confirmation", async () => {
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    mode: "tui",
    custom: tui.custom,
  });
  let attempts = 0;
  const pending = saveReviewedDraft(ctx, "Review sync setup", ["Exact path: work/archive"], "Save setup", async () => {
    if (++attempts === 1) throw Object.assign(new Error("Cannot write settings"), { code: "ENOSPC" });
  });
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();
  assert.equal(attempts, 1);
  assert.match(notifications[0]?.message ?? "", /draft is retained/u);
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /Free disk space/u);
  tui.press("tui.select.confirm");
  assert.equal(await pending, true);
  assert.equal(attempts, 2);
});

test.each(["cancel", "hard-cancel", "dispose", "replacement", "shutdown"])(
  "review %s cannot publish a late draft",
  async (action) => {
    const owner = new AbortController();
    const keybindings = {
      getKeys: (binding: string) =>
        binding === "tui.select.confirm"
          ? ["ctrl+s" as const]
          : binding === "tui.select.cancel"
            ? ["ctrl+x" as const]
            : [],
      matches: (data: string, binding: string) => keybindings.getKeys(binding).some((key) => matchesKey(data, key)),
    };
    const tui = createTuiHarness({ width: 48, rows: 16, keybindings });
    const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
    let saves = 0;
    const pending = saveReviewedDraft(
      ctx,
      "Review sync setup",
      lines,
      "Save setup",
      async () => {
        saves++;
      },
      owner.signal,
    );
    await tui.waitForOpen();
    assert.match(stripVTControlCharacters(tui.render().join("\n")), /ctrl\+s/u);
    if (action === "cancel") tui.send("\u0018");
    else if (action === "hard-cancel") tui.press("ctrl+c");
    else if (action === "dispose") tui.dispose();
    else owner.abort(new DOMException(action, "AbortError"));
    tui.send("\u0013");
    assert.equal(await pending, false);
    assert.equal(saves, 0);
    assert.equal(tui.isOpen, false);
  },
);

test("session replacement aborts a pending save before its publication boundary", async () => {
  const owner = new AbortController();
  const tui = createTuiHarness();
  const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let published = false;
  let saveSignal: AbortSignal | undefined;
  const pending = saveReviewedDraft(
    ctx,
    "Review sync setup",
    lines,
    "Save setup",
    async (signal) => {
      saveSignal = signal;
      ready();
      await gate;
      signal.throwIfAborted();
      published = true;
    },
    owner.signal,
  );
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await started;
  owner.abort(new DOMException("Session replaced", "AbortError"));
  release();
  assert.equal(await pending, false);
  assert.equal(saveSignal?.aborted, true);
  assert.equal(published, false);
});

test("stale and invalid settings failures close the old review instead of retrying its payload", async () => {
  const tui = createTuiHarness();
  const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
  const pending = saveReviewedDraft(ctx, "Review sync setup", lines, "Save setup", async () => {
    throw new Error("Settings changed while review was open");
  });
  const rejected = assert.rejects(pending, /changed while/u);
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await rejected;
  assert.equal(tui.isOpen, false);
});
