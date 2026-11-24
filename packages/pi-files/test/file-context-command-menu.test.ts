import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { ContextOptions } from "../src/context-service.js";
import { registerFiles } from "../src/files.js";

initTheme("dark", false);

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(root: string, discoverFiles: ContextOptions["discoverFiles"]) {
  const mock = createMockPi();
  await registerFiles(mock.pi, {
    context: {
      settingsPath: join(root, "pi-file-context.json"),
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
      discoverFiles,
      createGit: async () => undefined,
    },
  });
  const tui = createTuiHarness({ width: 64, rows: 18 });
  const base = createMockContext({ mode: "tui", cwd: root, custom: tui.custom });
  const emit = async (type: string) => {
    for (const hook of mock.events.get(type) ?? []) await hook({ type }, base.ctx);
  };
  const command = mock.commands.get("files");
  const shortcut = mock.shortcuts.get("f8");
  assert.ok(command);
  assert.ok(shortcut);
  await emit("session_start");
  return {
    ...base,
    tui,
    files: (args: string) => Promise.resolve(command.handler(args, base.ctx)),
    shortcut: () => Promise.resolve(shortcut.handler(base.ctx)),
    close: async () => {
      await emit("session_shutdown");
      tui.dispose();
    },
  };
}

async function withFixture(discoverFiles: ContextOptions["discoverFiles"], run: (f: Fixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-files-browser-test-"));
  let f: Fixture | undefined;
  try {
    await writeFile(join(root, "example.ts"), "export const example = true;\n");
    f = await createFixture(root, discoverFiles);
    await run(f);
  } finally {
    await f?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(["browse", "shortcut"] as const)(
  "opens the same lazy browser and pastes a reference via %s",
  async (route) => {
    const entered = deferred<void>();
    const scan = deferred<string[]>();
    await withFixture(
      () => {
        entered.resolve();
        return scan.promise;
      },
      async (f) => {
        const running = route === "browse" ? f.files("browse") : f.shortcut();
        await entered.promise;
        try {
          await f.tui.waitForOpen();
          assert.match(f.tui.render().join("\n"), /Scanning project files/u);
          const scanClosed = f.tui.resultPromise;
          scan.resolve(["example.ts"]);
          await scanClosed;
          await f.tui.waitForOpen();
          assert.match(f.tui.render().join("\n"), /File Context · files/u);
          f.tui.send("\t");
          await running;
          assert.deepEqual(f.pastedEditorTexts, ["@example.ts "]);
        } finally {
          scan.resolve([]);
        }
      },
    );
  },
);

test.each(["cancel", "failure"] as const)("releases a scan after %s so Files can retry", async (outcome) => {
  const entered = deferred<void>();
  const result = deferred<Error>();
  let scanSignal: AbortSignal | undefined;
  let scans = 0;
  await withFixture(
    async (_root, { signal } = {}) => {
      if (++scans > 1) return ["example.ts"];
      scanSignal = signal;
      entered.resolve();
      throw await Promise.race([
        result.promise,
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    },
    async (f) => {
      const running = f.files("");
      await f.tui.waitForOpen();
      assert.match(f.tui.render().join("\n"), /→ Browse files/u);
      const managerClosed = f.tui.resultPromise;
      f.tui.press("tui.select.confirm");
      await managerClosed;
      await entered.promise;
      await f.tui.waitForOpen();
      assert.match(f.tui.render().join("\n"), /Scanning project files/u);
      if (outcome === "cancel") f.tui.press("tui.select.cancel");
      else result.resolve(new Error("scan \u001b[31mfailed"));
      await running;
      assert.equal(f.tui.openCount, 2, "a cancelled or failed scan must not mount an explorer");
      assert.equal(f.tui.isOpen, false);
      if (outcome === "cancel") assert.equal(scanSignal?.aborted, true);
      else {
        const notice = f.notifications.at(-1)?.message ?? "";
        assert.ok(!notice.includes("\u001b"));
        assert.match(notice, /could not scan.*\/files browse to retry/iu);
      }

      const retry = f.files("browse");
      await f.tui.waitForOpen();
      if (f.tui.render().join("\n").includes("Scanning project files")) {
        await f.tui.resultPromise;
        await f.tui.waitForOpen();
      }
      assert.match(f.tui.render().join("\n"), /File Context · files/u);
      f.tui.press("ctrl+c");
      await retry;
      assert.equal(scans, 2);
    },
  );
});
