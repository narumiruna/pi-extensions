import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { AgentEvidence } from "../src/sync/agent-candidate.js";
import { AgentResolutionRequired } from "../src/sync/agent-request.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousDependencies, enableContinuous, fakeContinuousTime } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";
import { deferred } from "./startup-check-helpers.js";

const evidence: AgentEvidence = {
  files: [],
  unsupported: [],
  units: [{ id: "0", path: "AGENTS.md", kind: "text", base: "base", local: "local", remote: "remote" }],
};

for (const prerequisite of ["validation", "reservation", "postresponse"] as const)
  for (const boundary of ["agent_start", "session_start", "reload", "shutdown", "foreground"] as const)
    test(`${boundary} drains resolver ${prerequisite} before releasing claims and locks`, async () =>
      withTempHome(async (agentDir) => {
        const fixture = await createMergeFixture(agentDir);
        await enableContinuous();
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
        await fixture.remoteEdit("AGENTS.md", "remote\n");
        const entered = deferred();
        const aborted = deferred();
        const release = deferred();
        let received: AbortSignal | undefined;
        let drained = false;
        let idle = true;
        let validations = 0;
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
        const context = agentContext(selectRemote, { isIdle: () => idle });
        const mock = createMockPi();
        const { default: extension } = await import("../src/sync-extension.js");
        extension(
          mock.pi,
          continuousDependencies(fixture.backend, {
            loadSyncOperations: async () => ({
              ...(await import("../src/sync/sync-operations.js")),
              syncBoth: async (_ctx, options) => {
                if (options.agentAcceptance) {
                  commits++;
                  return "applied";
                }
                if (prerequisite === "reservation") {
                  assert.ok(options.background);
                  const reserve = options.background.reserve;
                  options.background.reserve = async (key, signal) => {
                    await reserve(key, signal);
                    await block(signal);
                  };
                }
                throw new AgentResolutionRequired("a".repeat(64), evidence, async (signal) => {
                  validations++;
                  // One outer validation precedes the resolver's three validation calls.
                  if (validations === (prerequisite === "validation" ? 2 : prerequisite === "postresponse" ? 4 : -1))
                    await block(signal);
                });
              },
            }),
          }),
        );
        fakeContinuousTime();
        const dispose = vi.spyOn(AgentSession.prototype, "dispose");
        let interruption: Promise<unknown> | undefined;
        let cleanupContext = context.ctx;
        try {
          await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
          await entered.promise;
          assert.ok(received, "the lifecycle-owned prerequisite must receive the resolver signal");
          assert.equal(received.aborted, false);
          assert.equal(dispose.mock.calls.length, 0);
          idle = false;
          let interrupted = false;
          if (boundary === "foreground")
            interruption = Promise.resolve(mock.commands.get("sync")?.handler("help", context.ctx));
          else if (boundary === "session_start") {
            const replacement = createMockContext({ mode: "rpc", isIdle: () => false });
            cleanupContext = replacement.ctx;
            interruption = Promise.resolve(mock.events.get("session_start")?.[0]?.({ reason: "new" }, replacement.ctx));
          } else {
            const event = boundary === "agent_start" ? "agent_start" : "session_shutdown";
            const reason = boundary === "shutdown" ? "quit" : "reload";
            interruption = Promise.resolve(mock.events.get(event)?.[0]?.({ reason }, context.ctx));
          }
          const completed = Promise.resolve(interruption).then(() => {
            interrupted = true;
          });
          await aborted.promise;
          assert.equal(received.aborted, true);
          assert.equal(drained, false);
          assert.equal(interrupted, false, "lifecycle cleanup must await prerequisite drain");
          assert.equal(dispose.mock.calls.length, 0);
          await fs.stat(path.join(agentDir, "pi-sync/agent-resolver/claim.json"));
          await fs.stat(path.join(agentDir, "pi-sync/continuous/scheduler.lock"));
          release.resolve();
          await completed;
          assert.equal(drained, true);
          assert.equal(dispose.mock.calls.length, 1);
          assert.equal(commits, 0);
          assert.equal(context.requests.length, prerequisite === "postresponse" ? 1 : 0);
          assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
          for (const owned of ["agent-resolver/claim.json", "continuous/scheduler.lock", "lock", "lock.guard"])
            await assert.rejects(fs.stat(path.join(agentDir, "pi-sync", owned)), /ENOENT/);
          await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
          await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
          assert.equal(dispose.mock.calls.length, 1, "repeated cleanup must not dispose again");
        } finally {
          release.resolve();
          await interruption;
          await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, cleanupContext);
          dispose.mockRestore();
          vi.useRealTimers();
        }
      }));
