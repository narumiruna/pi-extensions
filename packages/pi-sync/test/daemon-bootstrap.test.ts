import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureDaemon, findDaemon } from "@narumitw/pi-sync-daemon";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const cases = [
  { name: "absent agent root", file: undefined, raw: undefined, configured: false },
  {
    name: "empty setup",
    file: "pi-sync.json",
    raw: JSON.stringify({ version: 3, onSwitch: "switch-only", storageConnections: {}, syncSetups: {} }),
    configured: false,
  },
  { name: "unsupported document", file: "pi-sync.json", raw: '{"version":99,"future":{"keep":true}}\n', invalid: true },
  { name: "malformed document", file: "pi-sync.json", raw: "{ unfinished", invalid: true, malformed: true },
  { name: "legacy filename", file: "pi-sync.local.json", raw: JSON.stringify(v3S3Settings()), configured: true },
] as const;

for (const row of cases)
  test(`read-only configuration bootstrap preserves ${row.name} without a service`, () =>
    withTempHome(async (agentDir) => {
      if (row.file) {
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(path.join(agentDir, row.file), row.raw, { mode: 0o600 });
      }
      // Import after the owned agent-root environment is installed.
      const { bindPiDaemonClient, installPiDaemonHost, withPiDaemonClient } = await import(
        "../src/daemon/pi-client.js"
      );
      const { readActiveLocalConfigDocumentForRepair } = await import("../src/settings/config-file.js");
      installPiDaemonHost();
      const ctx = {
        sessionManager: {},
        ui: {},
        cwd: agentDir,
        mode: "rpc",
        hasUI: true,
        isIdle: () => true,
        get model() {
          throw new Error("Read-only bootstrap must not inspect or initialize a model.");
        },
        get modelRegistry() {
          throw new Error("Read-only bootstrap must not initialize provider credentials.");
        },
      } as unknown as ExtensionContext;
      const client = bindPiDaemonClient(ctx, new AbortController().signal);
      try {
        await withPiDaemonClient(ctx, async () => {
          if ("invalid" in row) await assert.rejects(client.configured());
          else assert.equal(await client.configured(), row.configured);
          if ("malformed" in row) await assert.rejects(readActiveLocalConfigDocumentForRepair());
          else {
            const document = await readActiveLocalConfigDocumentForRepair();
            assert.deepEqual(document?.parsed, row.raw === undefined ? undefined : JSON.parse(row.raw));
          }
        });
        assert.equal(await findDaemon(agentDir), undefined);
        if (row.file) {
          assert.equal(await fs.readFile(path.join(agentDir, row.file), "utf8"), row.raw);
          assert.deepEqual(await fs.readdir(agentDir), [row.file]);
        } else await assert.rejects(fs.stat(agentDir), { code: "ENOENT" });
      } finally {
        await client.dispose();
      }
    }));

for (const debug of [false, true])
  test(`an empty catalog latches debug=${debug} without starting a daemon`, () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = { version: 3, onSwitch: "switch-only", debug, storageConnections: {}, syncSetups: {} };
      await fs.writeFile(path.join(agentDir, "pi-sync.json"), JSON.stringify(settings));
      const { default: extension } = await import("../src/sync-extension.js");
      const { piDaemonClient } = await import("../src/daemon/pi-client.js");
      const mock = createMockPi();
      const context = createMockContext({ mode: "rpc" });
      extension(mock.pi);
      try {
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        const client = piDaemonClient(context.ctx);
        assert.equal((client as unknown as { facts(): { startupDebug: boolean } }).facts().startupDebug, debug);
        assert.equal(
          context.notifications.filter((item) => item.message.startsWith("pi-sync debug: local initialization")).length,
          debug ? 1 : 0,
        );
        await fs.writeFile(path.join(agentDir, "pi-sync.json"), JSON.stringify({ ...settings, debug: !debug }));
        assert.equal((client as unknown as { facts(): { startupDebug: boolean } }).facts().startupDebug, debug);
        assert.equal(await findDaemon(agentDir), undefined);
      } finally {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      }
    }));

for (const mode of ["print", "json"] as const)
  test(`a configured ${mode} lifecycle never starts a service`, () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "pi-sync.json"), JSON.stringify(v3S3Settings({ automatic: true })));
      const { default: extension } = await import("../src/sync-extension.js");
      const mock = createMockPi();
      const context = createMockContext({ mode, hasUI: false });
      extension(mock.pi);
      try {
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        assert.equal(await findDaemon(agentDir), undefined);
      } finally {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
      }
      assert.equal(await findDaemon(agentDir), undefined);
    }));

for (const mode of ["print", "json"] as const)
  test(`a ${mode} lifecycle passively protects its session in an existing service`, () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "pi-sync.json"), JSON.stringify(v3S3Settings({ automatic: true })));
      const owner = await ensureDaemon(agentDir);
      const { default: extension } = await import("../src/sync-extension.js");
      const { piDaemonClient } = await import("../src/daemon/pi-client.js");
      const manager = SessionManager.create(agentDir);
      const mock = createMockPi();
      const context = createMockContext({ mode, hasUI: false, sessionManager: manager });
      extension(mock.pi);
      try {
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        const connection = await piDaemonClient(context.ctx).connect();
        assert.equal(connection.identity.instance, owner.identity.instance);
        assert.equal(connection.facts.mode, mode);
        assert.equal(connection.facts.hasUI, false);
        assert.equal(connection.facts.ready, false);
        assert.equal(connection.facts.sessionFile, manager.getSessionFile());
        assert.equal(context.notifications.length, 0);
      } finally {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
      }
      assert.equal((await findDaemon(agentDir))?.identity.instance, owner.identity.instance);
    }));

test("an agent-root change refuses reads instead of redirecting a live client", () =>
  withTempHome(async (agentDir) => {
    const { bindPiDaemonClient, installPiDaemonHost, withPiDaemonClient } = await import("../src/daemon/pi-client.js");
    installPiDaemonHost();
    const context = createMockContext({ mode: "rpc" });
    const client = bindPiDaemonClient(context.ctx, new AbortController().signal);
    const other = path.join(path.dirname(agentDir), "other-agent");
    try {
      process.env.PI_CODING_AGENT_DIR = other;
      await assert.rejects(
        async () => withPiDaemonClient(context.ctx, () => client.readSettings()),
        /Agent directory changed/u,
      );
      assert.equal(client.root, path.resolve(agentDir));
      await assert.rejects(fs.stat(other), { code: "ENOENT" });
    } finally {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await client.dispose();
    }
  }));

test("the public SDK's relative agent-root environment remains read-only and supported", () =>
  withTempHome(async (agentDir) => {
    const { bindPiDaemonClient, installPiDaemonHost, withPiDaemonClient } = await import("../src/daemon/pi-client.js");
    process.env.PI_CODING_AGENT_DIR = path.relative(process.cwd(), agentDir);
    installPiDaemonHost();
    const context = createMockContext({ mode: "rpc" });
    const client = bindPiDaemonClient(context.ctx, new AbortController().signal);
    try {
      assert.equal(client.root, path.resolve(agentDir));
      assert.equal(await withPiDaemonClient(context.ctx, () => client.configured()), false);
      await assert.rejects(fs.stat(agentDir), { code: "ENOENT" });
    } finally {
      await client.dispose();
      process.env.PI_CODING_AGENT_DIR = agentDir;
    }
  }));
