import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { installEngineFixtureHost } from "./engine-host.js";

const { run, config, compare } = vi.hoisted(() => ({ run: vi.fn(), config: vi.fn(), compare: vi.fn() }));
vi.mock("../src/daemon/pi-client.js", () => ({ piDaemonClient: () => ({ run, validate: vi.fn() }) }));
vi.mock("../src/settings/config.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfig: config,
}));
vi.mock("../src/ui/remote-selection-ui.js", () => ({ showRemoteSelectionReview: compare }));

const setup = {
  setupName: "work",
  connectionName: "work",
  include: ["skills"],
  onSwitch: "switch-only",
  backend: { type: "git", destination: { branch: "main", directory: "shared" } },
};

initTheme("dark", false);

for (const [policy, available, visible, hidden] of [
  [
    "legacy",
    undefined,
    ["Included paths", "Excluded paths", "Compare included paths"],
    ["Migrate to ignore file…", "Ignore file"],
  ],
  [
    "legacy",
    true,
    ["Migrate to ignore file…", "Compare sync policies"],
    ["Included paths", "Excluded paths", "Ignore file"],
  ],
  [
    "ignore-file",
    true,
    ["Ignore file", "Edit ignore rules…", "Compare sync policies"],
    ["Included paths", "Excluded paths", "Migrate to ignore file…", "Agent directory scope"],
  ],
  [
    "ignore-file",
    false,
    [],
    [
      "Ignore file",
      "Edit ignore rules…",
      "Compare sync policies",
      "Included paths",
      "Excluded paths",
      "Migrate to ignore file…",
      "Agent directory scope",
    ],
  ],
] as const) {
  test(`settings path actions reflect setup policy ${policy} and daemon capability ${available}`, async () => {
    installEngineFixtureHost();
    config.mockResolvedValue({
      ...setup,
      ...(policy === "ignore-file"
        ? { scope: "agent-directory", pathPolicy: policy, ignoreFile: ".work.syncignore" }
        : {}),
    });
    run.mockReset();
    if (available === undefined) run.mockRejectedValue(new Error("Unsupported daemon operation"));
    else run.mockResolvedValue({ available });
    compare.mockReset().mockResolvedValue({ kind: "back" });
    const select = vi.fn<(title: string, rows: string[]) => Promise<string | undefined>>();
    const runRoute = vi.fn(async () => undefined);
    if (visible.some((row) => row === "Compare sync policies")) select.mockResolvedValueOnce("Compare sync policies");
    select.mockResolvedValue(undefined);
    const { ctx, notifications } = createMockContext({ mode: "tui", select });
    await showSyncSettings(ctx, runRoute);
    const rows = select.mock.calls[0]?.[1];
    expect(rows, JSON.stringify(notifications)).toBeDefined();
    for (const label of visible) expect(rows).toContain(label);
    for (const label of hidden) expect(rows).not.toContain(label);
    const continued = visible.some((row) => row === "Compare sync policies");
    expect(compare).toHaveBeenCalledTimes(continued ? 1 : 0);
    if (continued) expect(compare.mock.calls[0]?.[1]).toBe("work");
    expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.capabilities"]);
    expect(runRoute).not.toHaveBeenCalled();
  });
}

test("RPC settings for an ignore setup shows the manual path, without reading rules", async () => {
  installEngineFixtureHost();
  config.mockResolvedValue({
    ...setup,
    scope: "agent-directory",
    pathPolicy: "ignore-file",
    ignoreFile: ".work.syncignore",
  });
  run.mockReset();
  const { ctx, notifications } = createMockContext({ mode: "rpc", select: async () => undefined });
  await showSyncSettings(ctx, async () => undefined);
  expect(notifications[0]?.message).toMatch(/Edit existing ignore rules manually: .*\.work\.syncignore/u);
  expect(notifications[0]?.message).not.toContain("Excluded paths:");
  expect(run).not.toHaveBeenCalled();
});
