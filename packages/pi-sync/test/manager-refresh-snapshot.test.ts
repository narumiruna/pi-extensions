import fs from "node:fs/promises";
import path from "node:path";
import { configureEngineHost, engineHost } from "@narumitw/pi-sync-daemon/engine/host";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfigForCheck, syncCheckConfigFingerprint } from "../src/settings/config.js";
import { type LocalConfigDocument, withConfigPublicationReadyHookForTest } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { showSetupSwitcher } from "../src/ui/setup/setup-switcher.js";
import { withTempHome } from "./helpers.js";

function setup(name: string, ignoreFile?: string) {
  return {
    storage: { connection: "primary", branch: "main", path: name },
    sync: {
      automatic: false,
      ...(ignoreFile ? { scope: "agent-directory", pathPolicy: "ignore-file", ignoreFile } : { include: ["skills"] }),
    },
  };
}

function settings(syncSetups: Record<string, ReturnType<typeof setup>>, activeSyncSetup = "home") {
  return {
    version: 8,
    activeSyncSetup,
    onSwitch: "switch-only",
    storageConnections: { primary: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
    syncSetups,
  };
}

async function save(root: string, value: ReturnType<typeof settings>) {
  await fs.mkdir(root, { recursive: true });
  const filename = path.join(root, "pi-sync.json");
  await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  return filename;
}

const free = async () => ({ kind: "free" as const });

async function withSettingsRead(
  read: (repair?: boolean) => Promise<LocalConfigDocument | undefined>,
  run: () => Promise<void>,
) {
  const host = engineHost();
  configureEngineHost({
    ...host,
    config: {
      read,
      update: async () => {
        throw new Error("Unexpected settings update");
      },
      create: async () => {
        throw new Error("Unexpected settings creation");
      },
      replace: async () => {
        throw new Error("Unexpected settings replacement");
      },
    },
  });
  try {
    await run();
  } finally {
    configureEngineHost(host);
  }
}

test.each([1, 10])("refresh schedules one settings read for %i setups", (count) =>
  withTempHome(async (root) => {
    const parsed = settings(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => {
          const name = index === count - 1 ? "home" : `setup-${index}`;
          return [name, setup(name)];
        }),
      ),
    );
    const read = vi.fn(async (_repair?: boolean) => ({
      parsed,
      path: path.join(root, "pi-sync.json"),
      bytes: Buffer.from(JSON.stringify(parsed)),
      identity: { dev: 1, ino: 1 },
    }));
    await withSettingsRead(read, async () => {
      const manager = await describeManagerState(undefined, undefined, free);
      expect(manager.actions.includes("Switch sync setup")).toBe(count > 1);
      expect(read.mock.calls).toEqual([[true]]);
    });
  }),
);

test("schema errors in the snapshot do not fall through to partial setup eligibility", () =>
  withTempHome(async (root) => {
    const parsed = settings({
      home: setup("home"),
      invalid: { ...setup("invalid"), storage: { connection: "missing", branch: "main", path: "invalid" } },
    });
    const filename = path.join(root, "pi-sync.local.json");
    const read = vi.fn(async (_repair?: boolean) => ({
      parsed,
      path: filename,
      bytes: Buffer.from(JSON.stringify(parsed)),
      identity: { dev: 1, ino: 1 },
    }));
    await withSettingsRead(read, async () => {
      const manager = await describeManagerState(undefined, undefined, free);
      expect(manager.title).toContain("Settings file needs repair");
      expect(manager.title).toContain(filename);
      expect(manager.actions).toEqual(["Help"]);
      expect(read.mock.calls).toEqual([[true]]);
    });
  }));

test("an unreadable settings snapshot is reported without retrying the read", () =>
  withTempHome(async (root) => {
    const filename = path.join(root, "pi-sync.local.json");
    const read = vi.fn(async (_repair?: boolean) => {
      throw new Error(`Invalid JSON in pi-sync config: ${filename}`);
    });
    await withSettingsRead(read, async () => {
      const manager = await describeManagerState(undefined, undefined, free);
      expect(manager.title).toContain(filename);
      expect(manager.actions).toEqual(["Help"]);
      expect(read.mock.calls).toEqual([[true]]);
    });
  }));

test("missing settings have no read side effects", () =>
  withTempHome(async (root) => {
    const manager = await describeManagerState(undefined, undefined, free);
    expect(manager.actions).toEqual(["Set up sync", "Help"]);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }));

test("mixed settings skip invalid rules and stop after the first usable alternate", () =>
  withTempHome(async (root) => {
    const filename = await save(
      root,
      settings({
        missing: setup("missing", ".syncignore"),
        invalid: setup("invalid", "invalid.rules"),
        usable: setup("usable", "usable.rules"),
        later: setup("later", "later.rules"),
        home: setup("home"),
      }),
    );
    await fs.writeFile(path.join(root, "invalid.rules"), "unsupported\\/separator\n");
    await fs.writeFile(path.join(root, "usable.rules"), "/auth.json\n");
    await fs.writeFile(path.join(root, "later.rules"), "/auth.json\n");
    const open = vi.spyOn(fs, "open");
    try {
      const manager = await describeManagerState(undefined, undefined, free);
      expect(manager.actions).toContain("Switch sync setup");
      expect(open.mock.calls.map(([file]) => file)).toEqual([
        filename,
        path.join(root, "invalid.rules"),
        path.join(root, "usable.rules"),
      ]);
      expect(manager.configReview?.fingerprint).toBe(syncCheckConfigFingerprint(await loadConfigForCheck()));
    } finally {
      open.mockRestore();
    }
  }));

test("active ignore-file fingerprints match the action loader without migrating the settings file", () =>
  withTempHome(async (root) => {
    const filename = await save(root, settings({ work: setup("work"), home: setup("home", "home.rules") }));
    const legacy = path.join(root, "pi-sync.local.json");
    await fs.rename(filename, legacy);
    await fs.writeFile(path.join(root, "home.rules"), "/auth.json\n");
    const open = vi.spyOn(fs, "open");
    try {
      const manager = await describeManagerState(undefined, undefined, free);
      expect(manager.actions).toContain("Switch sync setup");
      expect(open.mock.calls.map(([file]) => file)).toEqual([legacy, path.join(root, "home.rules")]);
      expect(manager.configReview?.fingerprint).toBe(syncCheckConfigFingerprint(await loadConfigForCheck()));
      await expect(fs.lstat(filename)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      open.mockRestore();
    }
  }));

test.each(["invalid", "missing"] as const)("%s rules do not count as a switchable alternate", (problem) =>
  withTempHome(async (root) => {
    await save(root, settings({ home: setup("home"), work: setup("work", ".syncignore") }));
    if (problem === "invalid") await fs.writeFile(path.join(root, ".syncignore"), "\0");
    const manager = await describeManagerState(undefined, undefined, free);
    expect(manager.actions).not.toContain("Switch sync setup");
    expect(manager.actions).toContain("Settings");
  }),
);

test.each(["busy", "unsupported", "cancelled"] as const)(
  "%s refresh performs no alternate eligibility reads",
  (status) =>
    withTempHome(async (root) => {
      const filename = await save(root, settings({ home: setup("home"), work: setup("work", "work.rules") }));
      await fs.writeFile(path.join(root, "work.rules"), "/auth.json\n");
      const open = vi.spyOn(fs, "open");
      try {
        const controller = new AbortController();
        const describe = describeManagerState(
          controller.signal,
          undefined,
          async () => {
            if (status === "cancelled") controller.abort(new Error("Refresh cancelled"));
            return status === "busy" ? { kind: "recoverable-unreadable" } : { kind: "free" };
          },
          undefined,
          async () => status !== "unsupported",
        );
        if (status === "cancelled") await expect(describe).rejects.toThrow("Refresh cancelled");
        else expect((await describe).actions).not.toContain("Switch sync setup");
        expect(open.mock.calls.map(([file]) => file)).toEqual([filename]);
      } finally {
        open.mockRestore();
      }
    }),
);

test("refresh observes a settings save queued before it", () =>
  withTempHome(async (root) => {
    await save(root, settings({ home: setup("home"), work: setup("work") }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withConfigPublicationReadyHookForTest(
      async () => {
        entered.resolve();
        await release.promise;
      },
      async () => {
        const write = updateLocalConfig((current) => ({ ...current, activeSyncSetup: "work" }));
        try {
          await Promise.race([entered.promise, write]);
          const read = describeManagerState(undefined, undefined, free);
          release.resolve();
          const [manager] = await Promise.all([read, write]);
          expect(manager.configReview?.setupName).toBe("work");
          expect(manager.actions).toContain("Switch sync setup");
        } finally {
          release.resolve();
          await write;
        }
      },
    );
  }));

test("the displayed snapshot survives a concurrent removal but cannot authorize a stale switch", () =>
  withTempHome(async (root) => {
    const initial = settings({ home: setup("home"), work: setup("work") });
    const filename = await save(root, initial);
    const manager = await describeManagerState(undefined, undefined, async () => {
      await save(root, settings({ home: initial.syncSetups.home }));
      return { kind: "free" };
    });
    expect(manager.actions).toContain("Switch sync setup");
    const confirm = vi.fn(async () => true);
    const { ctx, notifications } = createMockContext({ mode: "rpc", confirm });
    const runRoute = vi.fn(async () => undefined);
    expect(await showSetupSwitcher(ctx, runRoute, "work")).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(runRoute).not.toHaveBeenCalled();
    expect(notifications.at(-1)?.message).toContain("no longer exists");
    expect(JSON.parse(await fs.readFile(filename, "utf8")).activeSyncSetup).toBe("home");
  }));

test.each(["settings", "rules"] as const)("a switch rechecks %s changed after the exact preview", (change) =>
  withTempHome(async (root) => {
    const ruleFile = "work.rules";
    const filename = await save(root, settings({ home: setup("home"), work: setup("work", ruleFile) }));
    const rulePath = path.join(root, ruleFile);
    await fs.writeFile(rulePath, "/auth.json\n");
    expect((await describeManagerState(undefined, undefined, free)).actions).toContain("Switch sync setup");
    const confirm = vi.fn(async () => {
      if (change === "settings") await save(root, settings({ home: setup("home"), work: setup("changed", ruleFile) }));
      else await fs.unlink(rulePath);
      return true;
    });
    const { ctx, notifications } = createMockContext({ mode: "rpc", confirm });
    const runRoute = vi.fn(async () => undefined);
    expect(await showSetupSwitcher(ctx, runRoute, "work")).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(notifications.at(-1)?.message).toMatch(/was not switched.*(?:changed|does not exist)/u);
    expect(JSON.parse(await fs.readFile(filename, "utf8")).activeSyncSetup).toBe("home");
    expect(runRoute).not.toHaveBeenCalled();
  }),
);
