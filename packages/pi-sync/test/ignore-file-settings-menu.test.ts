import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadSettingsConfig, syncSettingsConfigFingerprint } from "../src/settings/config.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { withTempHome } from "./helpers.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/daemon/pi-client.js", () => ({ piDaemonClient: () => ({ run, validate: vi.fn() }) }));

const ruleFile = ".work.syncignore";

type Policy = "legacy" | "directory" | "ignore-file";
type Automation = { automaticTransfer?: boolean; agentMode?: boolean; continuous?: boolean };

function setup(policy: Policy, storagePath: string, automation?: Automation) {
  return {
    storage: { connection: "work", branch: "main", path: storagePath },
    sync: {
      automatic: false,
      ...automation,
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
  { other, filename = "pi-sync.json", automation }: { other?: Policy; filename?: string; automation?: Automation } = {},
) {
  await fs.mkdir(root, { recursive: true });
  const settings = JSON.stringify({
    version: 8,
    activeSyncSetup: "work",
    onSwitch: "switch-only",
    storageConnections: { work: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
    syncSetups: { work: setup(policy, "shared", automation), ...(other ? { other: setup(other, "other") } : {}) },
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
      expect(presentation).toContain(`Edit existing ignore rules manually: ${rulePath}`);
      if (mode === "tui") expect(presentation).toContain("Setup preferences are read-only");
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

const policyFingerprint = "a".repeat(64);
const reviewPolicy = "Review current policy…";

function selectSyncMode(choice: string | undefined) {
  return vi
    .fn<(title: string, rows: string[]) => Promise<string | undefined>>()
    .mockResolvedValueOnce("Sync mode")
    .mockResolvedValueOnce(choice)
    .mockResolvedValue(undefined);
}

test.each(["approved", "cancelled", "setup changed"] as const)(
  "Sync mode can review Custom without rewriting flags: %s",
  (outcome) =>
    withTempHome(async (root) => {
      const { settingsPath, settings } = await writeSetup(root, "ignore-file", {
        automation: { automaticTransfer: true },
      });
      let approved = false;
      let reads = 0;
      run.mockReset().mockImplementation(async (operation) => {
        if (operation === "ignore.capabilities") return { available: true };
        if (operation === "daemon.policy")
          return {
            setup: ++reads > 1 && outcome === "setup changed" ? "other" : "work",
            automatic: approved,
            fingerprint: policyFingerprint,
          };
        if (operation === "daemon.authorize-connected") {
          approved = outcome === "approved";
          return approved;
        }
        throw new Error(`Unexpected route ${operation}`);
      });
      const select = selectSyncMode(reviewPolicy);
      const { ctx, notifications } = createMockContext({ mode: "tui", select });
      const runRoute = vi.fn(async () => undefined);
      await showSyncSettings(ctx, runRoute);
      expect(select.mock.calls[0]?.[1]).toContain("Sync mode");
      expect(select.mock.calls[0]?.[1]).not.toContain("Review automatic transfers");
      expect(select.mock.calls[1]).toEqual(["Sync mode", ["Manual", "Automatic", reviewPolicy], expect.any(Object)]);
      expect(run.mock.calls.map(([operation, payload]) => [operation, payload])).toEqual([
        ["ignore.capabilities", {}],
        ["daemon.policy", {}],
        ["daemon.policy", {}],
        ...(outcome === "setup changed" ? [] : [["daemon.authorize-connected", { fingerprint: policyFingerprint }]]),
        ["daemon.policy", {}],
      ]);
      const resumed = select.mock.calls[2]?.[0] ?? "";
      expect(resumed).toMatch(/Sync mode\s+Custom/u);
      expect(resumed.includes("Review required")).toBe(outcome !== "approved");
      expect(runRoute).not.toHaveBeenCalled();
      expect(notifications.some(({ message }) => message.includes("Automatic work approved"))).toBe(
        outcome === "approved",
      );
      if (outcome === "setup changed") expect(notifications[0]?.message).toMatch(/Could not read the active policy/u);
      expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
    }),
);

test.each(["cancelled", "stale", "approval declined", "approval stale", "no approval token", "approved"] as const)(
  "Settings refreshes Sync mode after a reviewed save: %s",
  (outcome) =>
    withTempHome(async (root) => {
      const options = { other: "ignore-file" as const, automation: { automaticTransfer: true } };
      const { settingsPath, settings } = await writeSetup(root, "legacy", options);
      const expected = syncSettingsConfigFingerprint(await loadSettingsConfig());
      let persisted = settings;
      let approved = false;
      run.mockReset().mockImplementation(async (operation) => {
        if (operation === "ignore.capabilities") return { available: true };
        if (operation === "daemon.policy")
          return { setup: "work", automatic: approved, fingerprint: policyFingerprint };
        if (operation === "settings.sync-mode") {
          if (outcome === "cancelled") return { kind: "cancelled" };
          if (outcome === "stale") throw new Error("Sync setup changed; reopen Settings before changing the mode.");
          // Publish the daemon's durable result before the separate connected approval.
          ({ settings: persisted } = await writeSetup(root, "legacy", {
            ...options,
            automation: { automaticTransfer: false, agentMode: true, continuous: true },
          }));
          return {
            kind: "saved",
            reviewRequired: true,
            ...(outcome === "no approval token" ? {} : { fingerprint: policyFingerprint }),
          };
        }
        if (operation === "daemon.authorize-connected") {
          if (outcome === "approval stale") throw new Error("Sync policy changed during review.");
          approved = outcome === "approved";
          return approved;
        }
        throw new Error(`Unexpected route ${operation}`);
      });
      const select = selectSyncMode("Automatic");
      const { ctx, notifications } = createMockContext({ mode: "tui", select });
      const runRoute = vi.fn(async () => undefined);
      await showSyncSettings(ctx, runRoute);
      const saved = outcome !== "cancelled" && outcome !== "stale";
      const authorizes = saved && outcome !== "no approval token";
      expect(run.mock.calls.map(([operation, payload]) => [operation, payload])).toEqual([
        ["ignore.capabilities", {}],
        ["daemon.policy", {}],
        ["daemon.policy", {}],
        ["settings.sync-mode", { mode: "Automatic", expected }],
        ...(authorizes ? [["daemon.authorize-connected", { fingerprint: policyFingerprint }]] : []),
        ["daemon.policy", {}],
      ]);
      const resumed = select.mock.calls[2]?.[0] ?? "";
      expect(resumed).toMatch(saved ? /Sync mode\s+Automatic/u : /Sync mode\s+Custom/u);
      expect(resumed.includes("Review required")).toBe(outcome !== "approved");
      expect(await fs.readFile(settingsPath, "utf8")).toBe(persisted);
      const messages = notifications.map(({ message }) => message);
      if (outcome === "stale") expect(messages).toEqual([expect.stringMatching(/save failed.*setup changed/iu)]);
      else if (outcome === "cancelled") expect(messages).toEqual([]);
      else if (outcome === "approved") expect(messages).toEqual([expect.stringMatching(/saved and approved/u)]);
      else expect(messages).toEqual([expect.stringMatching(/saved.*(?:review current policy|approval failed)/iu)]);
      expect(runRoute).not.toHaveBeenCalled();
    }),
);

test.each(["Ctrl+C", "replaced session"] as const)("Sync mode ignores a late choice after %s", (reason) =>
  withTempHome(async (root) => {
    const { settingsPath, settings } = await writeSetup(root, "ignore-file");
    run.mockReset().mockResolvedValue({ available: true });
    let sessionId = "before";
    let intercept: Parameters<ExtensionCommandContext["ui"]["onTerminalInput"]>[0] | undefined;
    let consumed: boolean | undefined;
    let chooserAborted: boolean | undefined;
    const unsubscribe = vi.fn(() => {
      intercept = undefined;
    });
    const select = vi
      .fn<ExtensionCommandContext["ui"]["select"]>()
      .mockResolvedValueOnce("Sync mode")
      .mockImplementationOnce(async (_title, _rows, options) => {
        if (reason === "Ctrl+C") consumed = intercept?.("\u0003")?.consume;
        else sessionId = "replacement";
        chooserAborted = options?.signal?.aborted;
        return "Automatic";
      })
      .mockResolvedValue(undefined);
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      select,
      onTerminalInput: (listener: typeof intercept) => {
        intercept = listener;
        return unsubscribe;
      },
      sessionManager: { getSessionId: () => sessionId },
    });
    await showSyncSettings(ctx, async () => undefined);
    expect(select).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
    if (reason === "Ctrl+C") {
      expect(consumed).toBe(true);
      expect(chooserAborted).toBe(true);
    }
    expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.capabilities"]);
    expect(notifications).toEqual([]);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
  }),
);

test("Sync mode is read-only for a legacy setup when a mixed catalog requires a compatible daemon", () =>
  withTempHome(async (root) => {
    const { settingsPath, settings } = await writeSetup(root, "legacy", {
      other: "ignore-file",
      automation: { agentMode: true, continuous: true },
    });
    run.mockReset().mockResolvedValue({ available: false });
    const tui = createTuiHarness({ width: 100, rows: 16 });
    const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
    const select = vi.fn(async () => undefined);
    (ctx as ExtensionCommandContext).ui.select = select;
    const running = showSyncSettings(ctx, async () => undefined);
    let frame = "";
    try {
      await tui.waitForOpen();
      tui.send("\u001b[200~Sync mode\u001b[201~");
      frame = tui.render().join("\n");
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      tui.press("tui.select.cancel");
    } finally {
      tui.dispose();
      await running;
    }
    expect(frame).toMatch(/Sync mode\s+\(unavailable\) Automatic/u);
    expect(select).not.toHaveBeenCalled();
    expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.capabilities"]);
    expect(notifications).toEqual([]);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
  }));

test.each(["disposal", "session replacement", "shutdown"] as const)(
  "Sync mode releases a pending daemon review on %s",
  (reason) =>
    withTempHome(async (root) => {
      const { settingsPath, settings } = await writeSetup(root, "ignore-file");
      const owner = new AbortController();
      const entered = Promise.withResolvers<AbortSignal>();
      let sessionId = "before";
      run.mockReset().mockImplementation(async (operation, _payload, signal: AbortSignal) => {
        if (operation === "ignore.capabilities") return { available: true };
        if (operation === "settings.sync-mode") {
          return new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
            entered.resolve(signal);
          });
        }
        throw new Error(`Unexpected route ${operation}`);
      });
      const tui = createTuiHarness({
        width: 60,
        rows: 16,
        keybindings: {
          matches: (input, key) =>
            key === "tui.select.cancel" ? input === "q" : key === "tui.select.confirm" && input === "x",
          getKeys: (key) => (key === "tui.select.cancel" ? ["q"] : key === "tui.select.confirm" ? ["x"] : []),
        },
      });
      const { ctx, notifications } = createMockContext({
        mode: "tui",
        custom: tui.custom,
        sessionManager: { getSessionId: () => sessionId },
      });
      const select = vi.fn(async () => "Automatic");
      // Leave Kit's custom screen on the real harness, not createMockContext's select adapter.
      (ctx as ExtensionCommandContext).ui.select = select;
      const runRoute = vi.fn(async () => undefined);
      const running = showSyncSettings(ctx, runRoute, owner.signal);
      try {
        await tui.waitForOpen();
        tui.send("\u001b[200~Sync mode\u001b[201~");
        tui.send("x");
        const signal = await Promise.race([
          entered.promise,
          running.then(() => {
            throw new Error("Settings closed before entering the daemon review");
          }),
        ]);
        if (reason === "disposal") tui.dispose();
        else {
          if (reason === "session replacement") sessionId = "replacement";
          owner.abort();
        }
        await running;
        expect(signal.aborted).toBe(true);
        expect(select).toHaveBeenCalledOnce();
        expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.capabilities", "settings.sync-mode"]);
        expect(runRoute).not.toHaveBeenCalled();
        expect(notifications).toEqual([]);
        expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
      } finally {
        owner.abort();
        tui.dispose();
        await running;
      }
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
    run.mockReset().mockResolvedValue({ available: true });
    const custom = vi.fn(async () => undefined);
    const { ctx, notifications } = createMockContext({ mode: "rpc", custom });
    await showSyncSettings(ctx, async () => undefined);
    expect(notifications[0]?.message.split("\n")[0]).toBe(`Edit pi-sync settings manually: ${current.settingsPath}`);
    expect(notifications[0]?.message.includes(ruleFile)).toBe(!canonical);
    expect(notifications[0]?.message.includes("Settings → Sync mode → Review current policy…")).toBe(!canonical);
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
