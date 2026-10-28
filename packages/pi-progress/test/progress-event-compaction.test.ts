import assert from "node:assert/strict";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import type { ProgressStep } from "../src/progress-state.js";
import type { ProgressSettingsLoadResult } from "../src/settings.js";
import {
  createContext,
  createHarness,
  defaultSettingsResult,
  loadedSettings,
  setProgress,
} from "./progress-harness.js";

const pending: ProgressStep[] = [{ text: "work", status: "pending" }];
const labels = {
  "user-message": "Next consumed user message",
  "settled-cycle": "Next eligible future user cycle settled",
} as const;

async function menu(
  harness: ReturnType<typeof createHarness>,
  ctx: ExtensionContext,
  responses: (string | undefined)[],
) {
  const rpc = createRpcHarness(responses.map((response) => ({ kind: "select" as const, response })));
  Object.assign(ctx.ui, rpc.ui);
  const command = harness.commands.get("progress");
  assert.ok(command);
  await command.handler("", ctx as ExtensionCommandContext);
  assert.equal(rpc.remainingSteps, 0, JSON.stringify(rpc.dialogs));
  rpc.assertConsumed();
  return rpc;
}

async function arm(harness: ReturnType<typeof createHarness>, ctx: ExtensionContext, trigger: keyof typeof labels) {
  await menu(harness, ctx, ["Widget view", "Automatic compaction", labels[trigger], undefined, undefined, "Close"]);
}

async function view(harness: ReturnType<typeof createHarness>, ctx: ExtensionContext, action: string) {
  await menu(harness, ctx, ["Widget view", action, undefined, "Close"]);
}

function compact(current: ReturnType<typeof createContext>) {
  const lines = current.renderWidget();
  return lines.length === 2 && !lines.join("\n").includes("steps completed");
}

async function user(harness: ReturnType<typeof createHarness>, ctx: ExtensionContext) {
  await harness.emit("message_start", ctx, { message: { role: "user", content: "same text", timestamp: 0 } });
}

async function settle(harness: ReturnType<typeof createHarness>, ctx: ExtensionContext, aborted = false) {
  await harness.emit("agent_settled", ctx, { aborted });
}

for (const trigger of ["user-message", "settled-cycle"] as const) {
  test(`${trigger} is opt-in and uses consumed user messages, not input or assistant/tool/custom events`, async () => {
    const harness = createHarness();
    const current = createContext({ mode: "rpc" });
    await harness.emit("session_start", current.ctx);
    const result = await setProgress(harness, current.ctx, pending);
    await harness.emit("agent_start", current.ctx);
    await user(harness, current.ctx);
    await settle(harness, current.ctx);
    assert.equal(compact(current), false, "no automatic default");
    await arm(harness, current.ctx, trigger);
    const count = current.widgets.length;
    for (const source of ["interactive", "extension", "rpc"]) {
      // Handled/rejected/queued-and-cleared submissions have no consumed message.
      await harness.emit("input", current.ctx, { text: "queued input", source });
    }
    await harness.emit("agent_start", current.ctx);
    for (const role of ["assistant", "toolResult", "custom"]) {
      await harness.emit("message_start", current.ctx, { message: { role } });
    }
    await harness.emit("agent_end", current.ctx);
    await settle(harness, current.ctx);
    assert.equal(current.widgets.length, count);
    assert.equal(compact(current), false);
    await harness.emit("agent_start", current.ctx);
    await user(harness, current.ctx);
    if (trigger === "settled-cycle") {
      await harness.emit("agent_end", current.ctx);
      assert.equal(compact(current), false, "agent_end is only a run boundary");
      await settle(harness, current.ctx);
    }
    assert.equal(compact(current), true);
    const compactCount = current.widgets.length;
    await user(harness, current.ctx);
    await settle(harness, current.ctx);
    assert.equal(current.widgets.length, compactCount, "rule is consumed once");
    assert.deepEqual(result.details.steps, pending);
    assert.deepEqual(harness.entries, []);
    await harness.emit("session_shutdown", current.ctx);
  });
}

test("future settled cycle excludes the active cycle, including queued users and repeated run starts", async () => {
  const harness = createHarness();
  const current = createContext({ mode: "rpc" });
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, pending);
  await harness.emit("agent_start", current.ctx);
  await user(harness, current.ctx);
  await arm(harness, current.ctx, "settled-cycle");
  // Both batching modes can consume several steering/follow-up messages before
  // one settled event; retries and continuation starts do not create new cycles.
  for (let index = 0; index < 3; index++) {
    await harness.emit("agent_end", current.ctx);
    await harness.emit("agent_start", current.ctx);
    await user(harness, current.ctx);
  }
  await settle(harness, current.ctx);
  assert.equal(compact(current), false);
  await harness.emit("agent_start", current.ctx);
  await user(harness, current.ctx);
  await user(harness, current.ctx);
  await harness.emit("agent_end", current.ctx);
  assert.equal(compact(current), false);
  await settle(harness, current.ctx);
  assert.equal(compact(current), true);
  await harness.emit("session_shutdown", current.ctx);
});

for (const busyAt of ["entry", "after-settings-await"] as const) {
  test(`startup already busy at ${busyAt} cannot expire a future-cycle rule on the current cycle`, async () => {
    let resolve!: (result: ProgressSettingsLoadResult) => void;
    let idle = busyAt !== "entry";
    const harness = createHarness({
      loadSettings: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const current = createContext({ mode: "rpc", isIdle: () => idle });
    let runSignal = busyAt === "entry" ? new AbortController().signal : undefined;
    Object.defineProperty(current.ctx, "signal", { get: () => runSignal });
    const starting = harness.emit("session_start", current.ctx);
    // A late attachment has a live run signal. A run that starts while settings
    // load is observed through its public preparation hook, before agent_start.
    idle = false;
    if (busyAt === "after-settings-await") await harness.emit("before_agent_start", current.ctx);
    resolve(defaultSettingsResult());
    await starting;
    await setProgress(harness, current.ctx, pending);
    await arm(harness, current.ctx, "settled-cycle");
    await user(harness, current.ctx);
    idle = true;
    await settle(harness, current.ctx);
    assert.equal(compact(current), false, "the startup cycle must be excluded");
    runSignal = undefined;
    idle = false;
    await harness.emit("agent_start", current.ctx);
    await user(harness, current.ctx);
    idle = true;
    await settle(harness, current.ctx);
    assert.equal(compact(current), true);
    await harness.emit("session_shutdown", current.ctx);
  });
}

test.each(["entry", "after-settings-await"] as const)(
  "maintenance-only startup at %s does not exclude the first future user cycle",
  async (busyAt) => {
    let resolve!: (result: ProgressSettingsLoadResult) => void;
    let idle = busyAt !== "entry";
    const harness = createHarness({
      loadSettings: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const current = createContext({ mode: "rpc", isIdle: () => idle });
    const starting = harness.emit("session_start", current.ctx);
    idle = false;
    resolve(defaultSettingsResult());
    await starting;
    await setProgress(harness, current.ctx, pending);
    idle = true; // No agent run or agent_settled occurred during maintenance.
    await arm(harness, current.ctx, "settled-cycle");
    await harness.emit("agent_start", current.ctx);
    await user(harness, current.ctx);
    await settle(harness, current.ctx);
    assert.equal(compact(current), true);
    await harness.emit("session_shutdown", current.ctx);
  },
);

for (const operation of ["session_before_tree", "session_before_compact"] as const) {
  test(`arming during ${operation} permits the next idle user prompt`, async () => {
    let idle = true;
    const harness = createHarness();
    const current = createContext({ mode: "rpc", isIdle: () => idle });
    await harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, pending);
    idle = false;
    await harness.emit(operation, current.ctx, { reason: "manual", signal: new AbortController().signal });
    await arm(harness, current.ctx, "settled-cycle");
    idle = true; // Canceled or failed maintenance need not emit session_tree.
    await harness.emit("input", current.ctx, { source: "interactive", text: "Next user prompt" });
    idle = false;
    await harness.emit("before_agent_start", current.ctx);
    await harness.emit("agent_start", current.ctx);
    await user(harness, current.ctx);
    await settle(harness, current.ctx);
    assert.equal(compact(current), true);
    await harness.emit("session_shutdown", current.ctx);
  });
}

test("arming during run preparation excludes that busy cycle before agent_start", async () => {
  let idle = true;
  const harness = createHarness();
  const current = createContext({ mode: "rpc", isIdle: () => idle });
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, pending);
  // A later before_agent_start handler can still hold preparation before agent_start.
  idle = false;
  await harness.emit("before_agent_start", current.ctx);
  await arm(harness, current.ctx, "settled-cycle");
  await harness.emit("agent_start", current.ctx);
  await user(harness, current.ctx);
  idle = true;
  await settle(harness, current.ctx);
  assert.equal(compact(current), false);
  idle = false;
  await harness.emit("agent_start", current.ctx);
  await user(harness, current.ctx);
  idle = true;
  await settle(harness, current.ctx);
  assert.equal(compact(current), true);
  await harness.emit("session_shutdown", current.ctx);
});

for (const reason of ["threshold", "overflow"] as const) {
  for (const willRetry of [false, true]) {
    for (const stage of ["preparation", "post-run"] as const) {
      test(`${reason} compaction retry=${willRetry} at ${stage} remains in the real current cycle`, async () => {
        let idle = true;
        const harness = createHarness();
        const current = createContext({ mode: "rpc", isIdle: () => idle });
        await harness.emit("session_start", current.ctx);
        await setProgress(harness, current.ctx, pending);
        idle = false;
        if (stage === "post-run") {
          await harness.emit("before_agent_start", current.ctx);
          await harness.emit("agent_start", current.ctx);
          await harness.emit("agent_end", current.ctx);
        }
        // Automatic compaction is run evidence even before before_agent_start,
        // with no low-level signal, and even when it will not retry a response.
        await harness.emit("session_before_compact", current.ctx, { reason, willRetry });
        await arm(harness, current.ctx, "settled-cycle");
        await harness.emit("session_compact", current.ctx, { reason, willRetry });
        if (stage === "preparation") await harness.emit("before_agent_start", current.ctx);
        await harness.emit("agent_start", current.ctx);
        await user(harness, current.ctx);
        idle = true;
        await settle(harness, current.ctx);
        assert.equal(compact(current), false);
        idle = false;
        await harness.emit("before_agent_start", current.ctx);
        await harness.emit("agent_start", current.ctx);
        await user(harness, current.ctx);
        idle = true;
        await settle(harness, current.ctx);
        assert.equal(compact(current), true);
        await harness.emit("session_shutdown", current.ctx);
      });
    }
  }
}

for (const recovery of ["idle-arm", "next-preparation", "next-automatic-compaction"] as const) {
  test(`failed preparation without settlement recovers at ${recovery}`, async () => {
    let idle = true;
    const harness = createHarness();
    const current = createContext({ mode: "rpc", isIdle: () => idle });
    await harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, pending);
    idle = false;
    await harness.emit("before_agent_start", current.ctx);
    await arm(harness, current.ctx, "settled-cycle");
    // _prepareRun rejects after its hook. No agent_start or agent_settled follows.
    idle = true;
    if (recovery === "idle-arm") await arm(harness, current.ctx, "settled-cycle");
    idle = false;
    if (recovery === "next-automatic-compaction") {
      await harness.emit("session_before_compact", current.ctx, { reason: "threshold", willRetry: false });
    }
    await harness.emit("before_agent_start", current.ctx);
    await harness.emit("agent_start", current.ctx);
    await user(harness, current.ctx);
    idle = true;
    await settle(harness, current.ctx);
    assert.equal(compact(current), true, "the abandoned preparation cannot exclude this future cycle");
    await harness.emit("session_shutdown", current.ctx);
  });
}

for (const outcome of ["error", "aborted", "retry-success"] as const) {
  test(`future-cycle eligibility handles ${outcome} without treating settled as success`, async () => {
    const harness = createHarness();
    const current = createContext({ mode: "rpc" });
    await harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, pending);
    await arm(harness, current.ctx, "settled-cycle");
    await harness.emit("agent_start", current.ctx);
    await user(harness, current.ctx);
    await harness.emit("message_end", current.ctx, {
      message: { role: "assistant", stopReason: outcome === "aborted" ? "aborted" : "error" },
    });
    await harness.emit("agent_end", current.ctx);
    if (outcome === "retry-success") {
      await harness.emit("agent_start", current.ctx);
      await harness.emit("message_end", current.ctx, { message: { role: "assistant", stopReason: "stop" } });
    }
    await settle(harness, current.ctx, outcome === "aborted");
    assert.equal(compact(current), outcome === "retry-success");
    if (outcome !== "retry-success") {
      // An eligible custom/tool-only future cycle without new user activity does
      // not consume the armed rule after a failure or startup/backoff abort.
      await harness.emit("agent_start", current.ctx);
      await settle(harness, current.ctx);
      assert.equal(compact(current), false);
      await harness.emit("agent_start", current.ctx);
      await user(harness, current.ctx);
      await settle(harness, current.ctx);
      assert.equal(compact(current), true);
    }
    await harness.emit("session_shutdown", current.ctx);
  });
}

test("semantic replacement rearms against current cycle; identical snapshots do not", async () => {
  const harness = createHarness();
  const current = createContext({ mode: "rpc" });
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, pending);
  await arm(harness, current.ctx, "settled-cycle");
  await harness.emit("agent_start", current.ctx);
  await user(harness, current.ctx);
  await setProgress(harness, current.ctx, [{ text: "new revision", status: "pending" }]);
  await settle(harness, current.ctx);
  assert.equal(compact(current), false);
  await harness.emit("agent_start", current.ctx);
  await user(harness, current.ctx);
  await setProgress(harness, current.ctx, [{ text: "new revision", status: "pending" }]);
  await settle(harness, current.ctx);
  assert.equal(compact(current), true);
  await harness.emit("session_shutdown", current.ctx);
});

for (const guard of ["pin", "blocked", "disabled", "hidden", "manual-expanded"] as const) {
  test(`${guard} prevents automatic compaction without editing saved progress`, async () => {
    const harness = createHarness({ loadSettings: async () => loadedSettings({ enabled: guard !== "disabled" }) });
    const current = createContext({ mode: "rpc" });
    await harness.emit("session_start", current.ctx);
    const steps: ProgressStep[] = [{ text: "saved work", status: guard === "blocked" ? "blocked" : "pending" }];
    const result = await setProgress(harness, current.ctx, steps);
    await arm(harness, current.ctx, "user-message");
    if (guard === "pin") await view(harness, current.ctx, "Pin widget");
    if (guard === "hidden") await view(harness, current.ctx, "Hide widget");
    if (guard === "manual-expanded") await view(harness, current.ctx, "Show detailed view");
    await user(harness, current.ctx);
    assert.equal(compact(current), false);
    assert.deepEqual(result.details.steps, steps);
    if (guard === "pin") {
      await view(harness, current.ctx, "Unpin widget");
      await user(harness, current.ctx);
      assert.equal(compact(current), true, "pin leaves the guarded rule armed");
    }
    if (guard === "hidden") {
      await setProgress(harness, current.ctx, pending);
      assert.deepEqual(current.renderWidget(), []);
      await view(harness, current.ctx, "Show widget");
      assert.ok(current.renderWidget().length > 0);
    }
    assert.deepEqual(harness.entries, []);
    await harness.emit("session_shutdown", current.ctx);
  });
}

test("tree and same-manager session reset invalidate armed rules and manual choices", async () => {
  const harness = createHarness();
  const current = createContext({ mode: "rpc" });
  await harness.emit("session_start", current.ctx);
  for (const boundary of ["session_tree", "session_start"] as const) {
    await setProgress(harness, current.ctx, pending);
    await arm(harness, current.ctx, "user-message");
    await view(harness, current.ctx, "Pin widget");
    await harness.emit(boundary, current.ctx);
    await setProgress(harness, current.ctx, pending);
    await user(harness, current.ctx);
    assert.equal(compact(current), false);
    const rpc = await menu(harness, current.ctx, ["Status", "Back", "Close"]);
    assert.match(rpc.dialogs[1]?.title ?? "", /default · unpinned · trigger: manual/u);
  }
  await harness.emit("session_shutdown", current.ctx);
});
