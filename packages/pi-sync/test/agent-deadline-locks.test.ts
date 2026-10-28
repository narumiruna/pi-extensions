import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import type { AgentEvidence } from "../src/sync/agent-candidate.js";
import { AGENT_TIMEOUT_MS } from "../src/sync/agent-policy.js";
import { AgentResolutionRequired } from "../src/sync/agent-request.js";
import { withAgentSyncLock } from "../src/sync/agent-sync.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { mergeOptions } from "./merge-options.js";
import { deferred } from "./startup-check-helpers.js";

const evidence: AgentEvidence = {
  files: [],
  unsupported: [],
  units: [{ id: "0", path: "AGENTS.md", kind: "text", base: "base", local: "local", remote: "remote" }],
};

for (const boundary of ["validation", "reservation", "postresponse"] as const)
  test(`deadline drains ${boundary} and releases the real resolver claim and operation guard`, async () =>
    withTempHome(async (agentDir) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const entered = deferred();
      const aborted = deferred();
      const release = deferred();
      let received: AbortSignal | undefined;
      let drained = false;
      let validations = 0;
      let reservations = 0;
      let commits = 0;
      const block = async (signal?: AbortSignal) => {
        received = signal;
        const onAbort = () => aborted.resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
        entered.resolve();
        try {
          await release.promise;
        } finally {
          signal?.removeEventListener("abort", onAbort);
          drained = true;
        }
      };
      const mock = agentContext(selectRemote);
      const pending = withAgentSyncLock(
        mock.ctx,
        {
          ...mergeOptions,
          background: {
            validate: () => {},
            reserve: async (_key, signal) => {
              reservations++;
              if (boundary === "reservation") await block(signal);
            },
          },
        },
        async (options) => {
          if (options.agentAcceptance) {
            commits++;
            return;
          }
          throw new AgentResolutionRequired("b".repeat(64), evidence, async (signal) => {
            validations++;
            if (validations === (boundary === "validation" ? 2 : boundary === "postresponse" ? 4 : -1))
              await block(signal);
          });
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await entered.promise;
        assert.ok(received, "the resolver deadline must reach the lock-held prerequisite");
        await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS);
        await aborted.promise;
        assert.equal(received.aborted, true);
        assert.equal(received.reason.name, "TimeoutError");
        assert.equal(drained, false);
        await fs.stat(path.join(agentDir, "pi-sync/agent-resolver/claim.json"));
        if (boundary !== "reservation") await fs.stat(path.join(agentDir, "pi-sync/lock"));
        release.resolve();
        assert.equal(await pending, received.reason);
        assert.equal(drained, true);
        assert.equal(commits, 0);
        assert.equal(mock.requests.length, boundary === "postresponse" ? 1 : 0);
        assert.equal(reservations, boundary === "validation" ? 0 : 1);
        for (const owned of ["agent-resolver/claim.json", "agent-resolver/claim.json.lock", "lock", "lock.guard"])
          await assert.rejects(fs.stat(path.join(agentDir, "pi-sync", owned)), /ENOENT/);
        const candidates = await fs.readdir(path.join(agentDir, "pi-sync/agent-resolver"));
        assert.deepEqual(candidates, [], "cancellation must not publish a candidate");
      } finally {
        release.resolve();
        await pending;
        vi.useRealTimers();
      }
    }));
