import { resolve } from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { beforeEach, expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { manualIgnoreFileGuidance, showIgnoreFileAction } from "../src/ui/ignore-file-ui.js";
import { installEngineFixtureHost } from "./engine-host.js";

const { run, validate } = vi.hoisted(() => ({ run: vi.fn(), validate: vi.fn() }));
vi.mock("../src/daemon/pi-client.js", () => ({ piDaemonClient: () => ({ run, validate }) }));

const filename = ".work.syncignore";
const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+x" });
initTheme("dark", false);
beforeEach(() => {
  installEngineFixtureHost();
  run.mockReset().mockResolvedValue("saved");
  validate.mockReset();
});

function fixture(action: "switch" | "migrate", overrides: Record<string, unknown> = {}) {
  const tui = createTuiHarness({ width: 100, rows: 40, keybindings: keys });
  const owner = new AbortController();
  let sessionId = "initial";
  const context = createMockContext({
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    custom: tui.custom,
    ...overrides,
  });
  const pending = showIgnoreFileAction(context.ctx, "work", action, filename, owner.signal);
  const waitForOpen = () =>
    Promise.race([
      tui.waitForOpen(),
      pending.then(() => {
        throw new Error(`Ignore flow finished before opening UI: ${JSON.stringify(context.notifications)}`);
      }),
    ]);
  return { ...context, tui, owner, pending, waitForOpen, replaceSession: () => (sessionId = "replacement") };
}

for (const decision of ["saved", "cancelled"]) {
  test(`switch delegates review with the exact filename and expected current value: ${decision}`, async () => {
    run.mockResolvedValueOnce(decision);
    const flow = fixture("switch", { input: async () => ".syncignore" });
    try {
      await flow.pending;
      expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.switch"]);
      expect(run.mock.calls[0]?.[1]).toEqual({ setup: "work", filename: ".syncignore", expectedFilename: filename });
      expect(flow.notifications.some(({ message }) => message.startsWith("Ignore file selected"))).toBe(
        decision === "saved",
      );
    } finally {
      flow.tui.dispose();
    }
  });
}

test("migration delegates the review and save to one cancellable daemon job", async () => {
  const flow = fixture("migrate");
  try {
    await flow.pending;
    expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.migrate"]);
    expect(run.mock.calls[0]?.[1]).toEqual({ setup: "work" });
    expect(run.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(flow.notifications.at(-1)?.message).toContain("No transfer started");
  } finally {
    flow.tui.dispose();
  }
});

test.each(["ctrl+x", "ctrl+c", "dispose", "shutdown"])("%s aborts pending migration work", async (reason) => {
  const started = Promise.withResolvers<AbortSignal>();
  run.mockImplementation((_operation, _payload, signal: AbortSignal) => {
    started.resolve(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const flow = fixture("migrate");
  try {
    await flow.waitForOpen();
    const taskSignal = await started.promise;
    if (reason === "dispose") flow.tui.dispose();
    else if (reason === "shutdown") flow.owner.abort();
    else if (reason === "ctrl+c") flow.tui.press("ctrl+c");
    else flow.tui.send("\u0018");
    await flow.pending;
    expect(taskSignal.aborted).toBe(true);
    expect(flow.notifications).toEqual([]);
  } finally {
    flow.owner.abort();
    flow.tui.dispose();
    await flow.pending;
  }
});

test("a stale session does not use a filename returned by a replaced input", async () => {
  const entry = Promise.withResolvers<string>();
  const flow = fixture("switch", { input: () => entry.promise });
  flow.replaceSession();
  entry.resolve("replacement.rules");
  await flow.pending;
  expect(run).not.toHaveBeenCalled();
  expect(flow.notifications).toEqual([]);
});

test("manual creation guidance from the daemon is visible without a follow-up write", async () => {
  run.mockRejectedValueOnce(new Error(`Create /agent/${filename} with starter rule /sessions/ and retry.`));
  const flow = fixture("migrate");
  try {
    await flow.pending;
    expect(flow.notifications.at(-1)?.message).toContain(`/agent/${filename} with starter rule /sessions/ and retry`);
    expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.migrate"]);
  } finally {
    flow.tui.dispose();
  }
});

test.each(["rpc", "print", "json"] as const)("%s does not open a migration or switch review", async (mode) => {
  const custom = vi.fn<ExtensionCommandContext["ui"]["custom"]>();
  for (const action of ["migrate", "switch"] as const) {
    const flow = fixture(action, { mode, hasUI: mode === "rpc", custom });
    await flow.pending;
    expect(run).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  }
});

test("manual edit guidance gives an exact local path and warns about shared setups", () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  const message = manualIgnoreFileGuidance(filename);
  expect(message).toContain(resolve(agentDir, filename));
  expect(message).toContain("every setup using this local file");
  expect(message).toContain("do not rewrite remote history");
});
