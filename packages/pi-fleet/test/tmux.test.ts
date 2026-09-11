import assert from "node:assert/strict";
import { test } from "vitest";
import { TmuxAdapter, type TmuxCommandExecutor, TmuxLaunchError } from "../src/tmux.js";

function result(stdout = "", stderr = "", code = 0) {
  return { stdout, stderr, code, killed: false };
}

function adapter(execute: TmuxCommandExecutor, overrides: { tmuxEnvironment?: string; tmuxPane?: string } = {}) {
  return new TmuxAdapter({
    execute,
    tmuxEnvironment:
      overrides.tmuxEnvironment === undefined ? "/tmp/tmux-1000/default,1234,0" : overrides.tmuxEnvironment,
    tmuxPane: overrides.tmuxPane === undefined ? "%7" : overrides.tmuxPane,
  });
}

test("tmux adapter requires a current pane and per-pane environment support", async () => {
  await assert.rejects(
    adapter(async () => result("tmux 3.4\n"), { tmuxEnvironment: "" }).assertAvailable(),
    /running inside tmux/iu,
  );
  await assert.rejects(
    adapter(async () => result("tmux 3.4\n"), { tmuxPane: "pane-7" }).assertAvailable(),
    /current tmux pane/iu,
  );
  await assert.rejects(adapter(async () => result("tmux 3.1c\n")).assertAvailable(), /3\.2/u);
  await assert.rejects(adapter(async () => result("unexpected\n")).assertAvailable(), /version/iu);
  assert.equal(await adapter(async () => result("tmux 3.4\n")).assertAvailable(), "3.4");
});

test("tmux split targets the current pane and passes positional data for every direction", async () => {
  const directionFlags = {
    right: ["-h"],
    down: ["-v"],
    left: ["-h", "-b"],
    up: ["-v", "-b"],
  } as const;
  for (const direction of ["right", "down", "left", "up"] as const) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const tmux = adapter(async (command, args) => {
      calls.push({ command, args });
      return calls.length === 1 ? result("tmux 3.4\n") : result("%42\n");
    });
    assert.deepEqual(
      await tmux.spawnSplit({
        direction,
        cwd: "/tmp/project ' quoted",
        launcherCommand: "/tmp/launcher's path",
        environment: {
          PI_FLEET_INVITE: "pifleet:v1:secret-placeholder",
          PI_FLEET_LAUNCH_ID: "launch_123",
        },
        isCurrent: () => true,
      }),
      { terminalId: "%42", version: "3.4" },
    );
    assert.deepEqual(calls[0], { command: "tmux", args: ["-V"] });
    assert.deepEqual(calls[1], {
      command: "tmux",
      args: [
        "split-window",
        ...directionFlags[direction],
        "-c",
        "/tmp/project ' quoted",
        "-e",
        "PI_FLEET_INVITE=pifleet:v1:secret-placeholder",
        "-e",
        "PI_FLEET_LAUNCH_ID=launch_123",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "%7",
        "'/tmp/launcher'\"'\"'s path'",
      ],
    });
  }
});

test("tmux adapter rejects invalid split input before running tmux", async () => {
  let calls = 0;
  const tmux = adapter(async () => {
    calls += 1;
    return result("tmux 3.4\n");
  });
  await assert.rejects(
    tmux.spawnSplit({
      direction: "auto" as "right",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => true,
    }),
    /split direction is invalid/u,
  );
  await assert.rejects(
    tmux.spawnSplit({
      direction: "right",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: { "bad-key": "value" },
      isCurrent: () => true,
    }),
    /launch environment is invalid/u,
  );
  assert.equal(calls, 0);
});

test("tmux adapter cancels and suppresses stale work before split creation", async () => {
  let calls = 0;
  const tmux = adapter(async () => {
    calls += 1;
    return result("tmux 3.4\n");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tmux.spawnSplit({
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
    return result("tmux 3.4\n");
  });
  await assert.rejects(
    stale.spawnSplit({
      direction: "down",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => current,
    }),
    (error: unknown) => error instanceof TmuxLaunchError && !error.splitCreated && /stale/u.test(error.message),
  );
  assert.equal(calls, 1);
});

test("tmux adapter reports cancellation, invalid identity, and staleness after a split as partial", async () => {
  const during = new AbortController();
  let calls = 0;
  const cancelled = adapter(async () => {
    calls += 1;
    if (calls === 1) return result("tmux 3.4\n");
    during.abort();
    return result("%8\n");
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
    (error: unknown) => error instanceof TmuxLaunchError && error.splitCreated && error.terminalId === "%8",
  );

  calls = 0;
  const invalid = adapter(async () => {
    calls += 1;
    return calls === 1 ? result("tmux 3.4\n") : result("not-a-pane\n");
  });
  await assert.rejects(
    invalid.spawnSplit({
      direction: "left",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => true,
    }),
    (error: unknown) => error instanceof TmuxLaunchError && error.splitCreated,
  );

  let current = true;
  calls = 0;
  const stale = adapter(async () => {
    calls += 1;
    if (calls === 1) return result("tmux 3.4\n");
    current = false;
    return result("%9\n");
  });
  await assert.rejects(
    stale.spawnSplit({
      direction: "up",
      cwd: "/tmp",
      launcherCommand: "/tmp/launcher",
      environment: {},
      isCurrent: () => current,
    }),
    (error: unknown) => error instanceof TmuxLaunchError && error.splitCreated && error.terminalId === "%9",
  );
});
