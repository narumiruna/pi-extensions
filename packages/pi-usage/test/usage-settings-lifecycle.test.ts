import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark");

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const outcome of ["cancel", "abort", "dispose", "replacement", "stale-owner"] as const) {
  test(`Usage ${outcome} drains a committed save without stale UI publication`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "usage-ui-lifecycle-"));
    const started = gate();
    const release = gate();
    const path = join(root, "pi-usage.json");
    const runtime = createUsageSettingsRuntime({
      path,
      operations: {
        rename: async (from, to) => {
          started.resolve();
          await release.promise;
          await rename(from, to);
        },
      },
    });
    await runtime.reload();
    const owner = new AbortController();
    let current = true;
    const tui = createTuiHarness({ keybindings: getKeybindings() });
    const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const applied: { id: string; closed: boolean }[] = [];
    let settled = false;
    const running = showUsageSettings(
      ctx,
      runtime,
      owner.signal,
      () => current,
      (id, closed) => {
        // The caller owns session-generation guards for durable-save cleanup.
        if (current) applied.push({ id, closed });
      },
    ).finally(() => {
      settled = true;
    });
    t.onTestFinished(async () => {
      release.resolve();
      owner.abort();
      tui.dispose();
      await running;
      await runtime.flush();
      await rm(root, { recursive: true, force: true });
    });
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await started.promise;
    if (outcome === "cancel") tui.press("ctrl+c");
    else if (outcome === "stale-owner") {
      current = false;
      tui.press("ctrl+c");
    } else if (outcome === "dispose") tui.dispose();
    else {
      if (outcome === "replacement") current = false;
      owner.abort();
    }
    await Promise.resolve();
    assert.equal(tui.isOpen, false);
    assert.equal(settled, false, "the promise must retain ownership until the save settles");
    release.resolve();
    assert.equal(await running, true);
    assert.equal(JSON.parse(await readFile(path, "utf8")).codexFastMode, true);
    assert.deepEqual(
      applied,
      outcome === "replacement" || outcome === "stale-owner" ? [] : [{ id: "codexFastMode", closed: true }],
    );
  });
}

test("Usage save failure does not poison the next queued change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-ui-recovery-"));
  let failed = false;
  const runtime = createUsageSettingsRuntime({
    path: join(root, "pi-usage.json"),
    operations: {
      rename: async (from, to) => {
        if (!failed) {
          failed = true;
          throw new Error("publication rejected");
        }
        await rename(from, to);
      },
    },
  });
  await runtime.reload();
  const owner = new AbortController();
  const tui = createTuiHarness({ keybindings: getKeybindings() });
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const applied: string[] = [];
  const running = showUsageSettings(
    ctx,
    runtime,
    owner.signal,
    () => true,
    (id) => applied.push(id),
  );
  t.onTestFinished(async () => {
    owner.abort();
    tui.dispose();
    await running;
    await runtime.flush();
    await rm(root, { recursive: true, force: true });
  });
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  assert.equal(runtime.get().settings.codexFastMode, false);
  assert.equal(runtime.get().settings.codexStatusResetCountdown, false);
  assert.deepEqual(applied, ["codexStatusResetCountdown"]);
  assert.match(notifications.at(-1)?.message ?? "", /publication rejected/u);
  tui.press("ctrl+c");
  assert.equal(await running, true);
});
