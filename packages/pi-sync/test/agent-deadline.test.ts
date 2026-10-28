import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import type { AgentEvidence } from "../src/sync/agent-candidate.js";
import { AGENT_TIMEOUT_MS } from "../src/sync/agent-policy.js";
import { runAgentResolver } from "../src/sync/agent-runner.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { deferred } from "./startup-check-helpers.js";

const evidence: AgentEvidence = {
  files: [],
  unsupported: [],
  units: [{ id: "0", path: "AGENTS.md", kind: "text", base: "base", local: "local", remote: "remote" }],
};

for (const boundary of ["validation", "reservation", "reserved-validation", "postresponse"] as const)
  for (const cancellation of ["deadline", "caller"] as const)
    test(`${cancellation} drains ${boundary} before resolver disposal and prevents late acceptance`, async () => {
      vi.useFakeTimers();
      const dispose = vi.spyOn(AgentSession.prototype, "dispose");
      const entered = deferred();
      const release = deferred();
      const caller = new AbortController();
      const reason = new DOMException("Session replaced", "AbortError");
      const mock = agentContext(selectRemote);
      let received: AbortSignal | undefined;
      let drained = false;
      let settled = false;
      let validations = 0;
      let reservations = 0;
      let commits = 0;
      const block = async (signal?: AbortSignal) => {
        received = signal;
        entered.resolve();
        // Model a non-interruptible atomic publication followed by owned cleanup.
        try {
          await release.promise;
        } finally {
          drained = true;
        }
      };
      const pending = runAgentResolver(
        mock.ctx,
        evidence,
        async (signal) => {
          validations++;
          const target = boundary === "validation" ? 1 : boundary === "reserved-validation" ? 2 : 3;
          if (boundary !== "reservation" && validations === target) await block(signal);
        },
        caller.signal,
        async (signal) => {
          reservations++;
          if (boundary === "reservation") await block(signal);
        },
      ).then(
        () => {
          settled = true;
          commits++;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await entered.promise;
        assert.equal(dispose.mock.calls.length, 0);
        if (cancellation === "deadline") await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS);
        else {
          caller.abort(reason);
          await vi.advanceTimersByTimeAsync(0);
        }
        assert.ok(received, "every prerequisite must receive the resolver-owned signal");
        assert.notEqual(received, caller.signal, "the deadline must remain part of the callback signal");
        assert.equal(received.aborted, true);
        if (cancellation === "deadline") assert.equal(received.reason.name, "TimeoutError");
        else assert.equal(received.reason, reason);
        assert.equal(settled, false, "cancellation must not abandon the pending callback");
        assert.equal(drained, false);
        assert.equal(dispose.mock.calls.length, 0, "dispose must follow callback drain");
        release.resolve();
        assert.equal(await pending, received.reason);
        assert.equal(drained, true);
        assert.equal(commits, 0);
        assert.equal(dispose.mock.calls.length, 1);
        assert.equal(mock.requests.length, boundary === "postresponse" ? 1 : 0);
        assert.equal(
          validations,
          boundary === "validation" || boundary === "reservation" ? 1 : boundary === "reserved-validation" ? 2 : 3,
        );
        assert.equal(reservations, boundary === "validation" ? 0 : 1, "spent reservations are not rolled back");
        assert.equal(mock.notifications.length, 0, "cancelled output must not be announced");
        assert.equal(vi.getTimerCount(), 0);
      } finally {
        caller.abort(reason);
        release.resolve();
        await pending;
        dispose.mockRestore();
        vi.useRealTimers();
      }
    });

test("all validation, reservation and transport calls share one live owned signal", async () => {
  const caller = new AbortController();
  const mock = agentContext(selectRemote);
  const signals: AbortSignal[] = [];
  const output = await runAgentResolver(
    mock.ctx,
    evidence,
    async (signal) => {
      signals.push(signal);
    },
    caller.signal,
    async (signal) => {
      signals.push(signal);
    },
  );
  assert.equal(JSON.parse(output).results[0].content, "remote");
  assert.equal(signals.length, 4);
  const transportSignal = (mock.requestOptions[0] as { signal: AbortSignal }).signal;
  assert.notEqual(transportSignal, caller.signal);
  assert.equal(transportSignal.aborted, false);
  assert.ok(signals.every((signal) => signal === transportSignal));
});
