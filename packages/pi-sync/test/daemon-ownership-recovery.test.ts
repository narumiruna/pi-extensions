import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  DaemonConnection,
  DaemonError,
  ensureDaemon,
  findDaemon,
  OWNERSHIP_CLEANUP_REQUIRED,
} from "@narumitw/pi-sync-daemon";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { v3WebDavSettings, withTempHome } from "./helpers.js";

initTheme("dark", false);

test.each([
  ["initialize", "rpc"],
  ["diff.review", "tui"],
] as const)("the %s failure exposes daemon recovery without another engine job (%s)", (operation, mode) =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(v3WebDavSettings()));
    const { default: extension } = await import("../src/sync-extension.js");
    const jobs: string[] = [];
    const original = DaemonConnection.prototype.run;
    const run = vi.spyOn(DaemonConnection.prototype, "run").mockImplementation(async function (
      this: DaemonConnection,
      ...args
    ) {
      jobs.push(args[0]);
      if (args[0] === operation) {
        if (operation === "initialize")
          throw new DaemonError({
            name: "Error",
            message: "Daemon ownership cleanup is uncertain; stop and reconcile before restarting.",
          });
        throw new DaemonError({
          name: "Error",
          message: "Pi settings lock release failed.",
          properties: { code: OWNERSHIP_CLEANUP_REQUIRED },
        });
      }
      return original.apply(this, args);
    });
    const selections: string[][] = [];
    const confirmations: string[] = [];
    const { ctx, notifications } = createMockContext({
      mode,
      select: async (_title: string, choices: string[]) => {
        selections.push(choices);
        return selections.length === 1 ? choices[0] : undefined;
      },
      confirm: async (_title: string, description: string) => {
        confirmations.push(description);
        return false;
      },
    });
    const mock = createMockPi();
    extension(mock.pi);
    try {
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      const command = mock.commands.get("sync");
      assert.ok(command);
      if (operation === "diff.review") {
        const tui = createTuiHarness();
        const ui = (ctx as ExtensionCommandContext).ui;
        const custom = ui.custom;
        ui.custom = tui.custom;
        try {
          await command.handler("diff", ctx);
          assert.equal(tui.isOpen, false);
        } finally {
          ui.custom = custom;
          tui.dispose();
        }
      }
      assert.ok(jobs.includes(operation));
      assert.ok(notifications.some((event) => /open \/sync/iu.test(event.message)));
      const owner = (await findDaemon(root))?.identity;
      assert.ok(owner);
      jobs.length = 0;
      await command.handler("", ctx);
      assert.match(selections[0]?.[0] ?? "", /Stop daemon for recovery/u);
      assert.match(confirmations[0] ?? "", new RegExp(`PID: ${owner.pid}`, "u"));
      assert.deepEqual(jobs, []);
      assert.equal((await findDaemon(root))?.identity.instance, owner.instance);
      await command.handler("daemon recover --yes", ctx);
      assert.equal(confirmations.length, 1);
      assert.match(notifications.at(-1)?.message ?? "", /Usage: \/sync daemon recover/u);
    } finally {
      run.mockRestore();
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
    }
  }),
);

test("an answer from a retired session cannot stop a reviewed owner", () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const original = await ensureDaemon(root);
    const { default: extension } = await import("../src/sync-extension.js");
    const prompted = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<boolean>();
    const { ctx, notifications } = createMockContext({
      mode: "rpc",
      confirm: async () => {
        prompted.resolve();
        return answer.promise;
      },
    });
    const mock = createMockPi();
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
    const command = mock.commands.get("sync");
    assert.ok(command);
    const recover = Promise.resolve(command.handler("daemon recover", ctx));
    void recover.catch(() => {});
    try {
      await Promise.race([prompted.promise, recover.then(() => assert.fail("Review did not open."))]);
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
    } finally {
      answer.resolve(true);
      await recover;
    }
    assert.equal((await findDaemon(root))?.identity.instance, original.identity.instance);
    assert.deepEqual(notifications, []);
  }));
