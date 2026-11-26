import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { runAgentResolver } from "../src/sync/agent-runner.js";
import { ContinuousError } from "../src/sync/continuous-errors.js";
import { acquireContinuousLease } from "../src/sync/continuous-lease.js";
import {
  continuousStatusLines,
  readContinuousRecord,
  reserveContinuousRequest,
} from "../src/sync/continuous-record.js";
import { continuousBinding } from "../src/sync/continuous-storage.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const evidence = {
  files: [],
  unsupported: [],
  units: [{ id: "0", path: "AGENTS.md", kind: "text" as const, base: "base", local: "left", remote: "right" }],
};

test("SDK dispatch is reserved durably; exhausted budgets disclose nothing and Status is read-only", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { agentMode: true, continuous: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const config = await loadConfig();
    // The lease prepares the private root; binding then uses its canonical state path.
    const { prepareContinuousRoot } = await import("../src/sync/continuous-storage.js");
    await prepareContinuousRoot();
    const binding = await continuousBinding(config);
    const lease = await acquireContinuousLease(binding);
    assert.ok(lease);
    const key = "a".repeat(64);
    try {
      const mock = agentContext(selectRemote);
      let sawReservation = false;
      mock.ctx.modelRegistry.streamSimple = new Proxy(mock.ctx.modelRegistry.streamSimple, {
        apply(target, receiver, args) {
          // The async check below ran before this synchronous public transport boundary.
          assert.equal(sawReservation, true);
          return Reflect.apply(target, receiver, args);
        },
      });
      const reserve = async () => {
        await reserveContinuousRequest(binding, lease, key);
        assert.equal((await readContinuousRecord(binding)).attempts[key], 1);
        sawReservation = true;
      };
      await runAgentResolver(mock.ctx, evidence, async () => lease.assert(), undefined, reserve);
      assert.equal(mock.requests.length, 1);
      await reserveContinuousRequest(binding, lease, key);
      const before = JSON.stringify(await readContinuousRecord(binding));
      await continuousStatusLines(config);
      assert.equal(JSON.stringify(await readContinuousRecord(binding)), before);
      await assert.rejects(
        runAgentResolver(
          mock.ctx,
          evidence,
          async () => lease.assert(),
          undefined,
          () => reserveContinuousRequest(binding, lease, key),
        ),
        /limit reached/,
      );
      assert.equal(mock.requests.length, 1);
    } finally {
      await lease.release();
    }
  }));

test("typed synchronous transport failures retain their safe retry category through the SDK", async () => {
  const mock = agentContext(selectRemote);
  mock.ctx.modelRegistry.streamSimple = () => {
    throw Object.assign(new Error("provider secret payload"), { code: "ECONNRESET" });
  };
  let reservations = 0;
  await assert.rejects(
    runAgentResolver(
      mock.ctx,
      evidence,
      async () => {},
      undefined,
      async () => {
        reservations++;
      },
    ),
    (error) => {
      assert.ok(error instanceof ContinuousError);
      assert.equal(error.kind, "transient");
      assert.doesNotMatch(error.message, /secret payload/);
      return true;
    },
  );
  assert.equal(reservations, 1);
});
