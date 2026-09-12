import assert from "node:assert/strict";
import { test } from "vitest";
import { ZellijAdapter, type ZellijCommandExecutor, ZellijLaunchError } from "../src/zellij.js";

function result(stdout = "", stderr = "", code = 0, killed = false) {
  return { stdout, stderr, code, killed };
}

function adapter(
  execute: ZellijCommandExecutor,
  overrides: { zellijEnvironment?: string; zellijPaneId?: string } = {},
) {
  return new ZellijAdapter({
    execute,
    zellijEnvironment: overrides.zellijEnvironment === undefined ? "0" : overrides.zellijEnvironment,
    zellijPaneId: overrides.zellijPaneId === undefined ? "7" : overrides.zellijPaneId,
  });
}

test("Zellij adapter requires a current pane and Zellij 0.44 or newer", async () => {
  await assert.rejects(
    adapter(async () => result("zellij 0.44.3\n"), { zellijEnvironment: "" }).assertAvailable(),
    /running inside Zellij/iu,
  );
  await assert.rejects(
    adapter(async () => result("zellij 0.44.3\n"), {
      zellijPaneId: "terminal_7",
    }).assertAvailable(),
    /current Zellij pane/iu,
  );
  await assert.rejects(adapter(async () => result("zellij 0.43.1\n")).assertAvailable(), /0\.44/u);
  await assert.rejects(adapter(async () => result("unexpected\n")).assertAvailable(), /version/iu);
  assert.equal(await adapter(async () => result("zellij 0.44.3\n")).assertAvailable(), "0.44.3");
});

test("Zellij split uses a visible private-launcher pane and pane-targeted placement for every direction", async () => {
  for (const direction of ["right", "down", "left", "up"] as const) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const zellij = adapter(async (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) return result("zellij 0.44.3\n");
      if (calls.length === 2) return result(`terminal_${direction === "up" ? 43 : 42}\n`);
      return result();
    });
    const terminalId = `terminal_${direction === "up" ? 43 : 42}`;
    assert.deepEqual(
      await zellij.spawnSplit({
        direction,
        cwd: "/tmp/project ' quoted",
        launcherCommand: "/tmp/launcher path",
        environment: {},
        isCurrent: () => true,
      }),
      { terminalId, version: "0.44.3" },
    );
    assert.deepEqual(calls[0], { command: "zellij", args: ["--version"] });
    assert.deepEqual(calls[1], {
      command: "zellij",
      args: [
        "action",
        "new-pane",
        "--direction",
        direction === "down" || direction === "up" ? "down" : "right",
        "--cwd",
        "/tmp/project ' quoted",
        "--",
        "/tmp/launcher path",
      ],
    });
    assert.doesNotMatch(JSON.stringify(calls[1]), /PI_FLEET|secret-placeholder|--near-current-pane/u);
    if (direction === "left" || direction === "up") {
      assert.deepEqual(calls[2], {
        command: "zellij",
        args: ["action", "move-pane", "--pane-id", terminalId, direction],
      });
    } else {
      assert.equal(calls.length, 2);
    }
  }
});

test("Zellij adapter rejects invalid split input before running Zellij", async () => {
  let calls = 0;
  const zellij = adapter(async () => {
    calls += 1;
    return result("zellij 0.44.3\n");
  });
  await assert.rejects(
    zellij.spawnSplit({
      direction: "auto" as "right",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => true,
    }),
    /split direction is invalid/u,
  );
  await assert.rejects(
    zellij.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: { PI_FLEET_INVITE: "pifleet:v1:secret-placeholder" },
      isCurrent: () => true,
    }),
    /private launcher/u,
  );
  assert.equal(calls, 0);
});

test("Zellij adapter cancels and suppresses stale work before pane creation", async () => {
  let calls = 0;
  const zellij = adapter(async () => {
    calls += 1;
    return result("zellij 0.44.3\n");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    zellij.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      signal: controller.signal,
      isCurrent: () => true,
    }),
    /aborted/u,
  );
  assert.equal(calls, 0);

  let current = true;
  calls = 0;
  const stale = adapter(async () => {
    calls += 1;
    current = false;
    return result("zellij 0.44.3\n");
  });
  await assert.rejects(
    stale.spawnSplit({
      direction: "down",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => current,
    }),
    (error: unknown) => error instanceof ZellijLaunchError && !error.splitCreated && /stale/u.test(error.message),
  );
  assert.equal(calls, 1);
});

test("Zellij adapter reports post-pane cancellation, identity, placement, and stale failures as partial", async () => {
  const during = new AbortController();
  let calls = 0;
  const cancelled = adapter(async () => {
    calls += 1;
    if (calls === 1) return result("zellij 0.44.3\n");
    during.abort();
    return result("terminal_8\n");
  });
  await assert.rejects(
    cancelled.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      signal: during.signal,
      isCurrent: () => true,
    }),
    (error: unknown) => error instanceof ZellijLaunchError && error.splitCreated && error.terminalId === "terminal_8",
  );

  calls = 0;
  const invalid = adapter(async () => {
    calls += 1;
    return calls === 1 ? result("zellij 0.44.3\n") : result("not-a-pane\n");
  });
  await assert.rejects(
    invalid.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => true,
    }),
    (error: unknown) => error instanceof ZellijLaunchError && error.splitCreated,
  );

  calls = 0;
  const placement = adapter(async () => {
    calls += 1;
    if (calls === 1) return result("zellij 0.44.3\n");
    if (calls === 2) return result("terminal_9\n");
    return result("", "move rejected", 1);
  });
  await assert.rejects(
    placement.spawnSplit({
      direction: "left",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => true,
    }),
    (error: unknown) =>
      error instanceof ZellijLaunchError &&
      error.splitCreated &&
      error.terminalId === "terminal_9" &&
      /placement/u.test(error.message),
  );

  const placementCancellation = new AbortController();
  calls = 0;
  const cancelledPlacement = adapter(async () => {
    calls += 1;
    if (calls === 1) return result("zellij 0.44.3\n");
    if (calls === 2) return result("terminal_10\n");
    placementCancellation.abort();
    return result();
  });
  await assert.rejects(
    cancelledPlacement.spawnSplit({
      direction: "up",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      signal: placementCancellation.signal,
      isCurrent: () => true,
    }),
    (error: unknown) =>
      error instanceof ZellijLaunchError &&
      error.splitCreated &&
      error.terminalId === "terminal_10" &&
      /cancelled/u.test(error.message),
  );

  let current = true;
  calls = 0;
  const stale = adapter(async () => {
    calls += 1;
    if (calls === 1) return result("zellij 0.44.3\n");
    if (calls === 2) return result("terminal_11\n");
    current = false;
    return result();
  });
  await assert.rejects(
    stale.spawnSplit({
      direction: "left",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => current,
    }),
    (error: unknown) => error instanceof ZellijLaunchError && error.splitCreated && error.terminalId === "terminal_11",
  );
});
