import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClientFacts } from "sync-daemon";
import { test } from "vitest";
import { withTempHome } from "./helpers.js";

for (const custom of [false, true])
  test(`public SDK session facts preserve ${custom ? "an explicit global-root override" : "the default project session layout"}`, () =>
    withTempHome(async (agentDir) => {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const { bindPiDaemonClient } = await import("../src/daemon/pi-client.js");
      const cwd = path.join(path.dirname(agentDir), "project");
      const override = custom ? path.join(agentDir, "sessions") : undefined;
      const manager = SessionManager.create(cwd, override);
      let active = true;
      const ctx = {
        get sessionManager() {
          if (!active) throw new Error("SDK context is closed");
          return manager;
        },
        cwd,
        mode: "rpc",
        hasUI: true,
        model: undefined,
        isIdle() {
          if (!active) throw new Error("SDK context is closed");
          return true;
        },
        ui: {},
      } as unknown as ExtensionContext;
      const client = bindPiDaemonClient(ctx, new AbortController().signal);
      try {
        // Own adapter boundary; no private API from the installed SDK is used.
        const facts = (client as unknown as { facts(): ClientFacts }).facts();
        assert.equal(manager.usesDefaultSessionDir(), !custom);
        assert.equal(facts.sessionDir, override === undefined ? undefined : await fs.realpath(override));
        assert.equal(facts.sessionId, manager.getSessionId());
        assert.ok(facts.sessionFile?.startsWith(await fs.realpath(agentDir)));
        active = false;
      } finally {
        await client.dispose();
      }
    }));
