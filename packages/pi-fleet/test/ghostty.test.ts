import assert from "node:assert/strict";
import { test } from "vitest";
import { GhosttyAdapter, type GhosttyCommandExecutor, GhosttyLaunchError } from "../src/ghostty.js";

function result(stdout = "", stderr = "", code = 0) {
  return { stdout, stderr, code, killed: false };
}

function adapter(
  execute: GhosttyCommandExecutor,
  overrides: { platform?: NodeJS.Platform; termProgram?: string } = {},
) {
  return new GhosttyAdapter({
    execute,
    platform: overrides.platform ?? "darwin",
    termProgram: overrides.termProgram ?? "ghostty",
  });
}

test("Ghostty adapter gates platform, terminal, and minimum version", async () => {
  await assert.rejects(adapter(async () => result("1.3.1\n"), { platform: "linux" }).assertAvailable(), /macOS/u);
  await assert.rejects(
    adapter(async () => result("1.3.1\n"), { termProgram: "iTerm.app" }).assertAvailable(),
    /current Ghostty terminal/u,
  );
  await assert.rejects(adapter(async () => result("1.2.9\n")).assertAvailable(), /1\.3 or newer/u);
  await assert.rejects(adapter(async () => result("broken\n")).assertAvailable(), /version/u);
  assert.equal(await adapter(async () => result("1.3.1\n")).assertAvailable(), "1.3.1");
});

test("Ghostty split uses static AppleScript and positional data for every direction", async () => {
  for (const direction of ["right", "down", "left", "up"] as const) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const ghostty = adapter(async (command, args) => {
      calls.push({ command, args });
      return calls.length === 1 ? result("1.3.1\n") : result(`terminal-${direction}\n`);
    });
    assert.deepEqual(
      await ghostty.spawnSplit({
        direction,
        cwd: "/tmp/project ' quoted",
        launcherCommand: "/tmp/launcher path",
        environment: {
          PI_FLEET_INVITE: "pifleet:v1:secret-placeholder",
          PI_FLEET_LAUNCH_ID: "launch_123",
        },
        isCurrent: () => true,
      }),
      { terminalId: `terminal-${direction}`, version: "1.3.1" },
    );
    assert.equal(calls[1]?.command, "osascript");
    const args = calls[1]?.args ?? [];
    assert.equal(args[0], "-e");
    assert.match(args[1] ?? "", /on run argv/u);
    assert.doesNotMatch(args[1] ?? "", /secret-placeholder|project ' quoted|launcher path/u);
    assert.deepEqual(args.slice(3), [
      direction,
      "/tmp/project ' quoted",
      "/tmp/launcher path",
      "PI_FLEET_INVITE=pifleet:v1:secret-placeholder",
      "PI_FLEET_LAUNCH_ID=launch_123",
    ]);
  }
});

test("Ghostty adapter cancels and suppresses stale work before split creation", async () => {
  let calls = 0;
  const ghostty = adapter(async () => {
    calls += 1;
    return result("1.3.1\n");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ghostty.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "direct:/tmp/launcher",
      environment: {},
      signal: controller.signal,
      isCurrent: () => true,
    }),
    /aborted/u,
  );
  assert.equal(calls, 0);

  const during = new AbortController();
  calls = 0;
  const cancelledDuringSplit = adapter(async () => {
    calls += 1;
    if (calls === 1) return result("1.3.1\n");
    during.abort();
    return result("terminal-cancelled\n");
  });
  await assert.rejects(
    cancelledDuringSplit.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      signal: during.signal,
      isCurrent: () => true,
    }),
    (error: unknown) =>
      error instanceof GhosttyLaunchError && error.splitCreated && error.terminalId === "terminal-cancelled",
  );

  let current = true;
  const stale = adapter(async () => {
    current = false;
    return result("1.3.1\n");
  });
  await assert.rejects(
    stale.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "direct:/tmp/launcher",
      environment: {},
      isCurrent: () => current,
    }),
    /stale/u,
  );
});

test("Ghostty adapter reports Automation, focus, and post-split stale failures", async () => {
  let calls = 0;
  const denied = adapter(async () => {
    calls += 1;
    return calls === 1 ? result("1.3.1\n") : result("", "Not authorized to send Apple events to Ghostty. (-1743)", 1);
  });
  await assert.rejects(
    denied.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "direct:/tmp/launcher",
      environment: {},
      isCurrent: () => true,
    }),
    /Automation permission/u,
  );

  calls = 0;
  const noFocus = adapter(async () => {
    calls += 1;
    return calls === 1 ? result("1.3.1\n") : result("", "Focused terminal is unavailable", 1);
  });
  await assert.rejects(
    noFocus.spawnSplit({
      direction: "down",
      cwd: "/tmp",
      launcherCommand: "direct:/tmp/launcher",
      environment: {},
      isCurrent: () => true,
    }),
    /focused terminal/u,
  );

  let current = true;
  calls = 0;
  const stale = adapter(async () => {
    calls += 1;
    if (calls === 1) return result("1.3.1\n");
    current = false;
    return result("terminal-new\n");
  });
  await assert.rejects(
    stale.spawnSplit({
      direction: "left",
      cwd: "/tmp",
      launcherCommand: "direct:/tmp/launcher",
      environment: {},
      isCurrent: () => current,
    }),
    (error: unknown) =>
      error instanceof GhosttyLaunchError && error.splitCreated && error.terminalId === "terminal-new",
  );
});
