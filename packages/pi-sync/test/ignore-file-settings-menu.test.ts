import fs from "node:fs/promises";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { withTempHome } from "./helpers.js";

const { run, compare } = vi.hoisted(() => ({ run: vi.fn(), compare: vi.fn() }));
vi.mock("../src/daemon/pi-client.js", () => ({ piDaemonClient: () => ({ run, validate: vi.fn() }) }));
vi.mock("../src/ui/remote-selection-ui.js", () => ({ showRemoteSelectionReview: compare }));

const ruleFile = ".work.syncignore";

async function writeSetup(root: string, policy: "legacy" | "ignore-file") {
  await fs.mkdir(root, { recursive: true });
  const settings = JSON.stringify({
    version: 8,
    activeSyncSetup: "work",
    onSwitch: "switch-only",
    storageConnections: { work: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
    syncSetups: {
      work: {
        storage: { connection: "work", branch: "main", path: "shared" },
        sync: {
          automatic: false,
          ...(policy === "ignore-file"
            ? { scope: "agent-directory", pathPolicy: policy, ignoreFile: ruleFile }
            : { include: ["skills"] }),
        },
      },
    },
  });
  const settingsPath = path.join(root, "pi-sync.json");
  await fs.writeFile(settingsPath, settings, { mode: 0o600 });
  return { settingsPath, settings };
}

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
  test(`settings path actions reflect setup policy ${policy} and daemon capability ${available}`, () =>
    withTempHome(async (root) => {
      await writeSetup(root, policy);
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
    }));
}

test.each(["tui", "rpc"] as const)("%s can open Settings from /sync while transfers are disabled", (mode) =>
  withTempHome(async (root) => {
    const { settingsPath, settings } = await writeSetup(root, "ignore-file");
    const rulePath = path.join(root, ruleFile);
    const rules = "# PRIVATE RULE CONTENT\n/sessions/\n";
    await fs.writeFile(rulePath, rules);
    await expect(loadConfig()).rejects.toThrow(/does not yet support/u);
    run.mockReset().mockResolvedValue({ available: false });
    const select = vi
      .fn<(title: string, rows: string[]) => Promise<string | undefined>>()
      .mockResolvedValueOnce("Settings")
      .mockResolvedValue(undefined);
    const runRoute = vi.fn(async () => undefined);
    const { ctx, notifications } = createMockContext({ mode, select });
    const open = vi.spyOn(fs, "open");
    try {
      await showSyncManager(ctx, runRoute);
      const [managerTitle, managerRows] = select.mock.calls[0] ?? [];
      expect(managerTitle).toContain("Transfers are unavailable");
      expect(managerRows).toContain("Settings");
      expect(managerRows?.join("\n")).not.toMatch(/Sync now|Push to remote|Pull from remote/u);
      expect(select.mock.calls[1]?.[0]).toContain(mode === "tui" ? "Pi Sync Settings" : "Sync settings management");
      const presentation = [select.mock.calls[1]?.[0], ...notifications.map(({ message }) => message)].join("\n");
      expect(presentation).toContain(`Edit existing ignore rules manually: ${rulePath}`);
      if (mode === "tui") expect(presentation).toContain("Setup preferences are read-only");
      expect(presentation).not.toMatch(/PRIVATE RULE CONTENT|Excluded paths:/u);
      expect(run.mock.calls.map(([operation]) => operation)).toEqual(mode === "tui" ? ["ignore.capabilities"] : []);
      expect(runRoute).not.toHaveBeenCalled();
      expect(open.mock.calls.some(([file]) => file === rulePath)).toBe(false);
      expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
      expect(await fs.readFile(rulePath, "utf8")).toBe(rules);
      expect((await fs.readdir(root)).sort()).toEqual([ruleFile, "pi-sync.json"].sort());
    } finally {
      open.mockRestore();
    }
  }),
);

test.each(["tui", "rpc"] as const)("%s does not present settings from a replaced session", (mode) =>
  withTempHome(async (root) => {
    const { settingsPath } = await writeSetup(root, "ignore-file");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const open = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === settingsPath) {
        entered.resolve();
        await release.promise;
      }
      return open(...args);
    });
    let sessionId = "before";
    const select = vi.fn(async () => undefined);
    const { ctx, notifications } = createMockContext({
      mode,
      select,
      sessionManager: { getSessionId: () => sessionId },
    });
    run.mockClear();
    const reading = showSyncSettings(ctx, async () => undefined);
    try {
      await Promise.race([
        entered.promise,
        reading.then(() => {
          throw new Error("Settings finished before reading the document");
        }),
      ]);
      sessionId = "replacement";
      release.resolve();
      expect(await reading).toBe("back");
      expect(select).not.toHaveBeenCalled();
      expect(notifications).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await reading.catch(() => undefined);
      spy.mockRestore();
    }
  }),
);

test("the manager rejects a Settings choice made against outdated settings", () =>
  withTempHome(async (root) => {
    const { settingsPath, settings } = await writeSetup(root, "ignore-file");
    const select = vi.fn().mockImplementationOnce(async () => {
      await fs.writeFile(settingsPath, settings.replace(ruleFile, "changed.rules"));
      return "Settings";
    });
    const { ctx, notifications } = createMockContext({ mode: "rpc", select });
    await showSyncManager(ctx, async () => undefined);
    expect(select.mock.calls.map(([title]) => String(title).split("\n")[0])).toEqual(["Manage sync", "Manage sync"]);
    expect(notifications).toEqual([
      {
        message: "Sync setup changed while the manager was open. Review the refreshed setup before continuing.",
        level: "warning",
      },
    ]);
  }));
