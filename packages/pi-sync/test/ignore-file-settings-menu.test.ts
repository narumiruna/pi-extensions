import fs from "node:fs/promises";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { withTempHome } from "./helpers.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/daemon/pi-client.js", () => ({ piDaemonClient: () => ({ run, validate: vi.fn() }) }));

const ruleFile = ".work.syncignore";

type Policy = "legacy" | "directory" | "ignore-file";

function setup(policy: Policy, storagePath: string) {
  return {
    storage: { connection: "work", branch: "main", path: storagePath },
    sync: {
      automatic: false,
      ...(policy === "ignore-file"
        ? { scope: "agent-directory", pathPolicy: policy, ignoreFile: ruleFile }
        : policy === "directory"
          ? { scope: "agent-directory", exclude: ["sessions"] }
          : { include: ["skills"] }),
    },
  };
}

async function writeSetup(
  root: string,
  policy: Policy,
  { other, filename = "pi-sync.json" }: { other?: Policy; filename?: string } = {},
) {
  await fs.mkdir(root, { recursive: true });
  const settings = JSON.stringify({
    version: 8,
    activeSyncSetup: "work",
    onSwitch: "switch-only",
    storageConnections: { work: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
    syncSetups: { work: setup(policy, "shared"), ...(other ? { other: setup(other, "other") } : {}) },
  });
  const settingsPath = path.join(root, filename);
  await fs.writeFile(settingsPath, settings, { mode: 0o600 });
  return { settingsPath, settings };
}

initTheme("dark", false);

const policyRows = [
  "Included paths",
  "Excluded paths",
  "Agent directory scope",
  "Migrate to ignore file…",
  "Ignore file",
  "Edit ignore rules…",
  "Compare included paths",
  "Compare sync policies",
];

for (const [policy, other, available, visible] of [
  ["legacy", undefined, undefined, ["Included paths", "Excluded paths", "Compare included paths"]],
  ["legacy", undefined, true, ["Included paths", "Excluded paths", "Migrate to ignore file…", "Compare sync policies"]],
  ["directory", undefined, false, ["Agent directory scope", "Compare sync policies"]],
  ["ignore-file", undefined, true, ["Ignore file", "Compare sync policies"]],
  ["ignore-file", undefined, false, []],
  ["ignore-file", "legacy", false, []],
  [
    "legacy",
    "ignore-file",
    true,
    ["Included paths", "Excluded paths", "Migrate to ignore file…", "Compare sync policies"],
  ],
  ["legacy", "ignore-file", false, []],
] as const) {
  test(`Settings paths for ${policy}, other setup ${other}, daemon capability ${available}`, () =>
    withTempHome(async (root) => {
      await writeSetup(root, policy, { other });
      run.mockReset();
      if (available === undefined) run.mockRejectedValue(new Error("Unsupported daemon operation"));
      else run.mockResolvedValue({ available });
      const select = vi.fn<(title: string, rows: string[]) => Promise<string | undefined>>();
      const runRoute = vi.fn(async () => undefined);
      select.mockResolvedValue(undefined);
      const { ctx, notifications } = createMockContext({ mode: "tui", select });
      await showSyncSettings(ctx, runRoute);
      const rows = select.mock.calls[0]?.[1];
      expect(rows, JSON.stringify(notifications)).toBeDefined();
      expect(rows?.filter((label) => policyRows.includes(label))).toEqual(visible);
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
      if (mode === "tui") {
        expect(presentation).toContain("Edit existing ignore rules manually:");
        expect(presentation).toContain("Setup preferences are read-only");
      } else {
        expect(presentation).toContain(`Edit existing ignore rules manually: ${rulePath}`);
      }
      expect(presentation).not.toMatch(/PRIVATE RULE CONTENT|Excluded paths:/u);
      const operations = run.mock.calls.map(([operation]) => operation);
      expect(operations.length).toBeGreaterThan(1);
      expect(new Set(operations)).toEqual(new Set(["ignore.capabilities"]));
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

test.each(["approved", "cancelled", "setup changed"] as const)(
  "automatic approval uses a separate Settings route: %s",
  (outcome) =>
    withTempHome(async (root) => {
      const { settingsPath, settings } = await writeSetup(root, "ignore-file");
      const value = JSON.parse(settings);
      value.syncSetups.work.sync.automaticTransfer = true;
      const before = JSON.stringify(value);
      await fs.writeFile(settingsPath, before);
      run.mockReset().mockImplementation(async (operation) => {
        if (operation === "ignore.capabilities") return { available: true };
        if (operation === "daemon.policy")
          return {
            setup: outcome === "setup changed" ? "other" : "work",
            automatic: false,
            fingerprint: "a".repeat(64),
          };
        if (operation === "daemon.authorize-connected") return outcome === "approved";
        throw new Error(`Unexpected route ${operation}`);
      });
      const select = vi
        .fn<(title: string, rows: string[]) => Promise<string | undefined>>()
        .mockResolvedValueOnce("Review automatic transfers")
        .mockResolvedValue(undefined);
      const { ctx, notifications } = createMockContext({ mode: "tui", select });
      const runRoute = vi.fn(async () => undefined);
      await showSyncSettings(ctx, runRoute);
      expect(select.mock.calls[0]?.[1]).toContain("Review automatic transfers");
      expect(run.mock.calls.map(([operation]) => operation)).toEqual([
        "ignore.capabilities",
        "daemon.policy",
        ...(outcome === "setup changed" ? [] : ["daemon.authorize-connected"]),
      ]);
      expect(runRoute).not.toHaveBeenCalled();
      expect(notifications.some(({ message }) => message.includes("Automatic work approved"))).toBe(
        outcome === "approved",
      );
      expect(await fs.readFile(settingsPath, "utf8")).toBe(before);
    }),
);

test.each([
  ["tui", "legacy", "ignore-file", true, true],
  ["rpc", "legacy", "ignore-file", true, true],
  ["tui", "legacy", "legacy", true, false],
  ["tui", "ignore-file", "ignore-file", true, false],
  ["tui", "legacy", "ignore-file", false, false],
] as const)("%s setup removal (%s and %s, confirmed: %s)", (mode, policy, other, confirmed, needsRecovery) =>
  withTempHome(async (root) => {
    const { settingsPath, settings } = await writeSetup(root, policy, { other });
    run.mockReset().mockResolvedValue({ available: true });
    const select = vi
      .fn<(title: string, rows: string[]) => Promise<string | undefined>>()
      .mockResolvedValueOnce("Manage sync setups")
      .mockResolvedValueOnce("other")
      .mockResolvedValueOnce("Remove sync setup…")
      .mockResolvedValue(undefined);
    const confirm = vi.fn(async () => confirmed);
    const runRoute = vi.fn(async () => undefined);
    const { ctx, notifications } = createMockContext({ mode, select, confirm });
    await showSyncSettings(ctx, runRoute);
    expect(confirm).toHaveBeenCalledOnce();
    const removed = notifications.find(({ message }) => message.includes("Removed sync setup"));
    expect(Boolean(removed)).toBe(confirmed);
    expect(removed?.message.includes("run /reload in an attached TUI session, or reopen one Pi client.") ?? false).toBe(
      needsRecovery,
    );
    const saved = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const expected = JSON.parse(settings);
    if (confirmed) delete expected.syncSetups.other;
    expect(saved).toEqual(expected);
    expect(runRoute).not.toHaveBeenCalled();
  }),
);

test.each([false, true])("RPC Settings keeps the legacy file unpromoted (canonical present: %s)", (canonical) =>
  withTempHome(async (root) => {
    const legacy = await writeSetup(root, "ignore-file", { filename: "pi-sync.local.json" });
    const current = canonical ? await writeSetup(root, "directory") : legacy;
    const custom = vi.fn(async () => undefined);
    const { ctx, notifications } = createMockContext({ mode: "rpc", custom });
    await showSyncSettings(ctx, async () => undefined);
    expect(notifications[0]?.message.split("\n")[0]).toBe(`Edit pi-sync settings manually: ${current.settingsPath}`);
    expect(notifications[0]?.message.includes(ruleFile)).toBe(!canonical);
    expect(custom).not.toHaveBeenCalled();
    expect(await fs.readFile(legacy.settingsPath, "utf8")).toBe(legacy.settings);
    expect((await fs.readdir(root)).sort()).toEqual(
      canonical ? ["pi-sync.json", "pi-sync.local.json"] : ["pi-sync.local.json"],
    );
  }),
);

test.each(["tui", "rpc"] as const)("%s Settings and setup catalog explain mixed-policy recovery", (mode) =>
  withTempHome(async (root) => {
    const { settingsPath, settings } = await writeSetup(root, "ignore-file", {
      other: "legacy",
      filename: "pi-sync.local.json",
    });
    run.mockReset().mockResolvedValue({ available: false });
    const select = vi
      .fn<(title: string, rows: string[]) => Promise<string | undefined>>()
      .mockResolvedValueOnce("Manage sync setups")
      .mockResolvedValueOnce("work (current)")
      .mockResolvedValueOnce("Back")
      .mockResolvedValueOnce("other")
      .mockResolvedValue(undefined);
    const { ctx, notifications } = createMockContext({ mode, select });
    const runRoute = vi.fn(async () => undefined);
    await showSyncSettings(ctx, runRoute);
    const [settingsView, catalog, current, _returnedCatalog, other] = select.mock.calls;
    expect([settingsView?.[0], notifications[0]?.message].join("\n")).toContain("switching setups are unavailable");
    expect(settingsView?.[1]).toContain("Manage sync setups");
    expect(catalog?.[1]).toEqual(expect.arrayContaining(["work (current)", "other"]));
    expect(catalog?.[1]).not.toContain("Add sync setup");
    expect(current?.[0]).toContain("Remove unavailable here; use manual recovery.");
    expect(other?.[0]).toContain("switching setups are unavailable");
    for (const detail of [current, other]) {
      expect(detail?.[0]).not.toMatch(/switch to another setup first|make this setup current|Status: Invalid/iu);
      expect(detail?.[0]).toContain("Set activeSyncSetup to a remaining setup");
      expect(detail?.[1]).toEqual(["Back"]);
    }
    if (mode === "rpc") expect(catalog?.[0]).toContain(settingsPath);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
    expect(await fs.readdir(root)).toEqual(["pi-sync.local.json"]);
    expect(runRoute).not.toHaveBeenCalled();
  }),
);

test("RPC storage catalog remains browsable without suggesting an unavailable switch", () =>
  withTempHome(async (root) => {
    const { settingsPath, settings } = await writeSetup(root, "ignore-file", { other: "legacy" });
    const select = vi
      .fn<(title: string, rows: string[]) => Promise<string | undefined>>()
      .mockResolvedValueOnce("Manage storage connections")
      .mockResolvedValueOnce("work")
      .mockResolvedValue(undefined);
    const { ctx } = createMockContext({ mode: "rpc", select });
    await showSyncSettings(ctx, async () => undefined);
    const [, catalog, connection] = select.mock.calls;
    expect(catalog?.[1]).toContain("work");
    expect(catalog?.[1]).not.toContain("Add storage connection");
    expect(connection?.[0]).toContain("Connection changes are unavailable");
    expect(connection?.[0]).not.toContain("Switch away");
    expect(connection?.[1]).toEqual(["Back"]);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
  }));

test.each([3, 4, 5, 6, 7, 8])("valid empty version %i settings show an empty manager", (version) =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const empty = JSON.stringify({ version, onSwitch: "switch-only", storageConnections: {}, syncSetups: {} });
    await fs.writeFile(path.join(root, "pi-sync.json"), empty, { mode: 0o600 });
    const manager = await describeManagerState();
    expect(manager.title).toContain("No sync setups are configured.");
    expect(manager.title).not.toContain("need attention");
    expect(manager.actions).toEqual(["Sync setups…", "Storage connections…", "Help"]);
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
