import assert from "node:assert/strict";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { GhosttyAdapter, GhosttyLaunchError } from "../src/ghostty.js";
import { createDefaultTerminalPort } from "../src/terminal.js";
import { TmuxAdapter, type TmuxCommandExecutor, TmuxLaunchError } from "../src/tmux.js";
import { ZellijAdapter, ZellijLaunchError } from "../src/zellij.js";

afterEach(() => vi.unstubAllEnvs());

function result(stdout: string, overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false, truncated: false, ...overrides };
}

const terminals = [
  {
    name: "tmux",
    version: "tmux 3.4\n",
    identity: "%42\n",
    error: TmuxLaunchError,
    adapter: (execute: TmuxCommandExecutor) => new TmuxAdapter({ execute, tmuxEnvironment: "session", tmuxPane: "%7" }),
  },
  {
    name: "Ghostty",
    version: "1.3.1\n",
    identity: "terminal-new\n",
    error: GhosttyLaunchError,
    adapter: (execute: TmuxCommandExecutor) =>
      new GhosttyAdapter({ execute, platform: "darwin", termProgram: "ghostty" }),
  },
  {
    name: "Zellij",
    version: "zellij 0.44.3\n",
    identity: "terminal_42\n",
    error: ZellijLaunchError,
    adapter: (execute: TmuxCommandExecutor) =>
      new ZellijAdapter({ execute, zellijEnvironment: "0", zellijPaneId: "7" }),
  },
];

for (const terminal of terminals) {
  test(`${terminal.name} rejects truncated versions before parsing or abort classification`, async () => {
    for (const code of [0, 1]) {
      const controller = new AbortController();
      const adapter = terminal.adapter(async () => {
        controller.abort();
        return result(terminal.version, { truncated: true, killed: code !== 0, code });
      });
      await assert.rejects(
        adapter.assertAvailable(controller.signal),
        (error: unknown) =>
          error instanceof terminal.error && !error.splitCreated && /output limit/u.test(error.message),
      );
    }
  });

  test(`${terminal.name} rejects truncated identities without trusting partial output`, async () => {
    for (const code of [0, 1]) {
      let calls = 0;
      const adapter = terminal.adapter(async () =>
        ++calls === 1
          ? result(terminal.version)
          : result(terminal.identity, {
              truncated: true,
              killed: code !== 0,
              code,
              stderr: "private launcher data",
            }),
      );
      await assert.rejects(
        adapter.spawnSplit({
          direction: "left",
          cwd: "/workspace",
          launcherCommand: "/private/launcher",
          environment: {},
          isCurrent: () => true,
        }),
        (error: unknown) =>
          error instanceof terminal.error &&
          error.splitCreated &&
          error.terminalId === undefined &&
          /output limit/u.test(error.message) &&
          !/timed out|private launcher data/u.test(error.message),
      );
      assert.equal(calls, 2, "no placement command may use the incomplete identity");
    }
  });

  test(`${terminal.name} preserves ordinary version failure and cancellation handling`, async () => {
    for (const failure of [{ killed: true }, { code: 1, stderr: "spawn ENOENT" }]) {
      await assert.rejects(
        terminal.adapter(async () => result(terminal.version, failure)).assertAvailable(),
        (error: unknown) => error instanceof terminal.error && !/output limit/u.test(error.message),
      );
    }
    await assert.rejects(
      terminal
        .adapter(async () => {
          throw new Error("spawn ENOENT");
        })
        .assertAvailable(),
      /ENOENT|could not run/u,
    );
    const controller = new AbortController();
    const adapter = terminal.adapter(async () => {
      controller.abort();
      return result(terminal.version);
    });
    await assert.rejects(adapter.assertAvailable(controller.signal), { name: "AbortError" });
  });
}

test("Zellij retains the known pane identity when placement output overflows", async () => {
  let calls = 0;
  const adapter = new ZellijAdapter({
    zellijEnvironment: "0",
    zellijPaneId: "7",
    execute: async () => {
      if (++calls === 1) return result("zellij 0.44.3\n");
      if (calls === 2) return result("terminal_42\n");
      return result("", { truncated: true, killed: true, code: 1 });
    },
  });
  await assert.rejects(
    adapter.spawnSplit({
      direction: "up",
      cwd: "/workspace",
      launcherCommand: "/private/launcher",
      environment: {},
      isCurrent: () => true,
    }),
    (error: unknown) =>
      error instanceof ZellijLaunchError &&
      error.splitCreated &&
      error.terminalId === "terminal_42" &&
      /placement output exceeded the output limit/u.test(error.message),
  );
});

test("default terminal execution bounds both query and split output and retains signals and timeouts", async () => {
  vi.stubEnv("TMUX", "session");
  vi.stubEnv("TMUX_PANE", "%7");
  vi.stubEnv("ZELLIJ", "0");
  vi.stubEnv("ZELLIJ_PANE_ID", "7");
  for (const name of ["tmux", "zellij"] as const) {
    const calls: Array<{ command: string; options: Parameters<ExtensionAPI["exec"]>[2] }> = [];
    const signal = new AbortController().signal;
    const pi = {
      exec: async (command, _args, options) => {
        calls.push({ command, options });
        if (calls.length === 1) return result(name === "tmux" ? "tmux 3.4\n" : "zellij 0.44.3\n");
        return result(name === "tmux" ? "%42\n" : "terminal_42\n");
      },
    } satisfies Pick<ExtensionAPI, "exec">;
    const port = createDefaultTerminalPort(pi as ExtensionAPI, name);
    await port.spawnSplit({
      direction: "right",
      cwd: "/workspace",
      launcherCommand: "/private/launcher",
      environment: {},
      signal,
      isCurrent: () => true,
    });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.command, name);
      assert.deepEqual(call.options, { signal, timeout: 5_000, maxBuffer: 16 * 1024 });
    }
  }
});
