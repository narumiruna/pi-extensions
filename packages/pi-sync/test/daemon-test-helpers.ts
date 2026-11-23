import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DaemonConnection, ensureDaemon } from "@narumitw/pi-sync-daemon";
import type { createMockPi } from "../../../test/support.js";
import { installPiDaemonHost } from "../src/daemon/pi-client.js";
import { installEngineFixtureHost } from "./engine-host.js";
export function assertDisposableAgentRoot(root: string) {
  const canonical = realpathSync(root);
  const temp = path.relative(realpathSync(tmpdir()), canonical).split(path.sep);
  const build = path.relative(realpathSync("packages/pi-sync"), canonical).split(path.sep);
  assert.ok(
    /^(?:pi-sync-(?:home|rpc)|pi-extension-status-contract)-[A-Za-z0-9]+$/u.test(temp[0] ?? "") ||
      /^\.pi-sync-build-test-[A-Za-z0-9]+$/u.test(build[0] ?? ""),
    "This operation is only allowed in disposable Pi Sync fixtures.",
  );
}

/** Explicit approval in disposable fixtures; never use this helper with a real agent root. */
export async function adoptFixtureRoot(root: string) {
  assertDisposableAgentRoot(root);
  const daemon = await ensureDaemon(root);
  const client = await new DaemonConnection(
    daemon.paths,
    daemon.identity,
    {
      id: randomUUID(),
      generation: randomUUID(),
      pid: process.pid,
      cwd: root,
      mode: "rpc",
      hasUI: true,
      idle: false,
    },
    {
      callback: async (callback) => {
        assert.equal(callback.kind, "confirm");
        assert.match((callback.payload as { message: string }).message, /every older Pi process/u);
        return true;
      },
    },
  ).attach();
  try {
    await client.run("daemon.handover", {});
  } finally {
    await client.dispose();
  }
}

/** Exercise the real registered lifecycle; parsing postconditions then use an explicit fixture host. */
export async function runRegisteredCommand(
  mock: ReturnType<typeof createMockPi>,
  ctx: ExtensionCommandContext,
  args: string,
) {
  installPiDaemonHost();
  try {
    for (const handler of mock.events.get("session_start") ?? [])
      await handler({ type: "session_start", reason: "startup" }, ctx);
    await mock.commands.get("sync")?.handler(args, ctx);
  } finally {
    try {
      for (const handler of mock.events.get("session_shutdown") ?? [])
        await handler({ type: "session_shutdown", reason: "reload" }, ctx);
    } finally {
      installEngineFixtureHost();
    }
  }
}
