import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxToolCall,
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { explicitWaitErrorScenario } from "./support/goal-explicit-wait-runtime.mjs";
import {
  assertNativeRetries,
  assertQuietErrorWait,
  completionResponse,
  continuationMessages,
  createHarness,
  goalIdFromContext,
  managedRunStatuses,
  persistedGoalHistory,
  persistedGoalState,
  persistedGoalStatus,
  providerError,
  seedCompactionHistory,
  userMessageText,
  waitFor,
  waitForSettlement,
} from "./support/goal-runtime-harness.mjs";

async function agentDirectoryIsolationScenario() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const harness = await createHarness([]);
  try {
    assert.equal(process.env.PI_CODING_AGENT_DIR, harness.agentDir);
  } finally {
    await harness.cleanup();
  }
  assert.equal(process.env.PI_CODING_AGENT_DIR, previousAgentDir);
}

async function normalContinuationScenario() {
  const harness = await createHarness([
    fauxAssistantMessage("First pass stopped without completion."),
    completionResponse,
  ]);
  const events = [];
  const unsubscribe = harness.session.subscribe((event) => events.push(event.type));
  try {
    await harness.session.prompt("/goal runtime continuation smoke");
    await waitFor(() => harness.faux.state.callCount === 2, "settled continuation");
    await harness.session.agent.waitForIdle();
    assert.equal(events.filter((type) => type === "agent_settled").length, 2);
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(harness.session.messages.map(userMessageText).some((text) => text.includes("pi-goal-continuation:")));
  } finally {
    unsubscribe();
    await harness.cleanup();
  }
}

async function runawayNoProgressScenario() {
  const harness = await createHarness([
    fauxAssistantMessage("Required phrase"),
    fauxAssistantMessage(""),
    fauxAssistantMessage("   ...   "),
    fauxAssistantMessage(""),
  ]);
  try {
    await harness.session.prompt('/goal Reply with exactly: "Required phrase"');
    await waitFor(() => harness.faux.state.callCount === 4, "no-progress safety pause");
    await harness.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.faux.state.callCount, 4);
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "no_progress");
    assert.equal(persistedGoalState(harness.session)?.goal?.toolFreeRepeatCount, 3);
    assert.equal(
      harness.session.messages.map(userMessageText).filter((text) => text.includes("pi-goal-continuation:")).length,
      3,
    );
  } finally {
    await harness.cleanup();
  }
}

async function automaticToolLoopLimitScenario() {
  const observedSignals = [];
  const toolResponse = (_context, options) => {
    observedSignals.push(options?.signal?.aborted === true);
    return fauxAssistantMessage(fauxToolCall("budget_probe", {}));
  };
  const harness = await createHarness(
    [
      fauxAssistantMessage("Start automatic work."),
      toolResponse,
      toolResponse,
      toolResponse,
      (_context, options) => {
        observedSignals.push(options?.signal?.aborted === true);
        assert.equal(options?.signal?.aborted, true);
        return fauxAssistantMessage("Synthetic aborted cleanup.");
      },
    ],
    {},
    undefined,
    { continuationLimits: { automaticTurns: 3, noProgressTurns: null } },
  );
  try {
    await harness.session.prompt("/goal bounded automatic tool loop");
    await harness.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "continuation_limit");
    assert.equal(persistedGoalState(harness.session)?.goal?.automaticModelTurns, 3);
    assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 3);
    assert.deepEqual(observedSignals.slice(0, 3), [false, false, false]);
    assert.ok(observedSignals.length <= 4);
    if (observedSignals.length === 4) assert.equal(observedSignals[3], true);
    assert.ok(harness.faux.state.callCount <= 5);
  } finally {
    await harness.cleanup();
  }
}

async function retryAtHardLimitScenario() {
  const observedSignals = [];
  const harness = await createHarness(
    [
      fauxAssistantMessage("Initial unfinished result."),
      (_context, options) => {
        observedSignals.push(options?.signal?.aborted === true);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "HTTP 524: transient upstream timeout",
        });
      },
      (_context, options) => {
        observedSignals.push(options?.signal?.aborted === true);
        assert.equal(options?.signal?.aborted, true);
        return fauxAssistantMessage("Guard-owned aborted retry cleanup.");
      },
    ],
    {},
    undefined,
    { continuationLimits: { automaticTurns: 1, noProgressTurns: null } },
    {
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    },
  );
  try {
    await harness.session.prompt("/goal retry cannot cross hard limit");
    await harness.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "continuation_limit");
    assert.equal(persistedGoalState(harness.session)?.goal?.automaticModelTurns, 1);
    assert.deepEqual(observedSignals.slice(0, 1), [false]);
    assert.ok(observedSignals.length <= 2, "hard limit allows at most one cleanup provider call");
    if (observedSignals.length === 2) assert.equal(observedSignals[1], true);
    assert.equal(harness.faux.state.callCount, observedSignals.length + 1);
  } finally {
    await harness.cleanup();
  }
}

async function automaticRetryOwnershipScenario() {
  const harness = await createHarness(
    [
      fauxAssistantMessage("Initial unfinished result."),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 524: transient upstream timeout",
      }),
      fauxAssistantMessage("Recovered provider response."),
      completionResponse,
    ],
    {},
    undefined,
    { continuationLimits: { automaticTurns: 3, noProgressTurns: null } },
    {
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    },
  );
  try {
    await harness.session.prompt("/goal runtime retry ownership smoke");
    await waitFor(() => harness.faux.state.callCount === 4, "provider retry and continuation");
    await harness.session.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(
      persistedGoalHistory(harness.session).some((goal) => goal.automaticModelTurns === 2 && goal.status === "active"),
      "retry response must retain automatic ownership",
    );
    assertNativeRetries(harness, [1], true, 1);
    assert.deepEqual(
      harness.sdkEvents.filter((event) => event.type === "agent_settled").map((event) => event.providerCalls),
      [1, 3, 4],
      "Goal continuation must wait for the native recovery run to settle",
    );
    assert.equal(continuationMessages(harness.session).length, 2, "native retry must not add a continuation");
    assert.equal(harness.lifecycleEvents.filter((event) => event === "agent_start").length, 4);
  } finally {
    await harness.cleanup();
  }
}

async function nativeRetryExhaustionScenario() {
  for (const [name, enabled, maxRetries, attempts] of [
    ["exhausted", true, 2, [1, 2]],
    ["disabled", false, 2, []],
    ["zero retries", true, 0, []],
  ]) {
    const expectedCalls = attempts.length + 1;
    const harness = await createHarness(
      [...Array.from({ length: expectedCalls }, () => providerError("HTTP 524: upstream timeout")), completionResponse],
      {},
      undefined,
      undefined,
      { retry: { enabled, maxRetries, baseDelayMs: 0 } },
    );
    try {
      await harness.session.prompt(`/goal native retry ${name} smoke`);
      await waitForSettlement(harness, `${name} retry settlement`);
      assertNativeRetries(harness, attempts, false);
      assert.equal(harness.faux.state.callCount, expectedCalls, `${name}: no Goal-owned retry loop`);
      assert.equal(harness.faux.getPendingResponseCount(), 1);
      assert.equal(continuationMessages(harness.session).length, 0);
      assert.equal(harness.session.pendingMessageCount, 0);
      assert.equal(harness.sdkEvents.filter((event) => event.type === "agent_settled").length, 1);
      const waitingGoal = persistedGoalState(harness.session)?.goal;
      assert.equal(waitingGoal?.status, "active", name);
      assert.match(waitingGoal.waiting?.reason ?? "", /provider retries exhausted/i);
      assert.equal(waitingGoal.waiting.resumeAt, undefined, "provider wait has no timer");
      await harness.session.prompt("Check the provider again and finish the same Goal.");
      await harness.session.waitForIdle();
      assert.equal(harness.faux.state.callCount, expectedCalls + 1);
      assert.equal(persistedGoalStatus(harness.session), null, "a follow-up must wake the waiting Goal");
      assert.deepEqual(
        new Set(persistedGoalHistory(harness.session).map((goal) => goal.id)),
        new Set([waitingGoal.id]),
      );
      assert.equal(continuationMessages(harness.session).length, 0);
      assertNativeRetries(harness, attempts, false);
    } finally {
      await harness.cleanup();
    }
  }
}

async function nativeRetryClassificationScenario() {
  const quota = "HTTP 503: insufficient credits";
  const auth = "HTTP 503: Unauthorized: invalid API key";
  const terminalAuth = "Unauthorized: invalid API key";
  const terminalQuota = "HTTP 429: insufficient_quota";
  const prematureClose = "Connection prematurely closed BEFORE response";
  for (const error of [quota, auth]) assert.equal(isRetryableAssistantError(providerError(error)), true, error);
  for (const error of [terminalAuth, terminalQuota, prematureClose]) {
    assert.equal(isRetryableAssistantError(providerError(error)), false, error);
  }

  for (const [name, responses, attempts, status] of [
    ["quota recovery", [providerError(quota), completionResponse], [1], null],
    ["auth recovery", [providerError(auth), completionResponse], [1], null],
    ["quota exhaustion", [providerError(quota), providerError(quota)], [1], "usage_limited"],
    ["final quota", [providerError(auth), providerError(terminalQuota)], [1], "usage_limited"],
    ["final auth", [providerError(auth), providerError(terminalAuth)], [1], "active"],
    ["native quota exclusion", [providerError(terminalQuota)], [], "usage_limited"],
    ["unknown premature close", [providerError(prematureClose)], [], "active"],
  ]) {
    const harness = await createHarness([...responses, completionResponse], {}, undefined, undefined, {
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    });
    try {
      await harness.session.prompt(`/goal native classification ${name} smoke`);
      await waitForSettlement(harness, `${name} settlement`);
      assertNativeRetries(harness, attempts, status === null);
      assert.equal(harness.faux.state.callCount, responses.length, `${name}: exact native provider attempts`);
      assert.equal(harness.faux.getPendingResponseCount(), 1, `${name}: no extra Goal retry`);
      assert.equal(persistedGoalStatus(harness.session), status, name);
      assert.equal(harness.sdkEvents.filter((event) => event.type === "agent_settled").length, 1);
      if (status === "active") {
        const waitingGoal = assertQuietErrorWait(harness, responses.length, /\S/u);
        assert.doesNotMatch(waitingGoal.waiting.reason, /retries exhausted/i, name);
        await harness.session.prompt("Complete the same Goal after the final unknown error.");
        await harness.session.waitForIdle();
        assert.equal(harness.faux.state.callCount, responses.length + 1);
        assert.equal(persistedGoalStatus(harness.session), null);
        assert.ok(persistedGoalHistory(harness.session).every((goal) => goal.id === waitingGoal.id));
        assertNativeRetries(harness, attempts, false);
      } else {
        assert.equal(persistedGoalState(harness.session)?.goal?.waiting, undefined, name);
      }
      assert.equal(continuationMessages(harness.session).length, 0, name);
    } finally {
      await harness.cleanup();
    }
  }
}

// Published #1821 error: preserve the nested raw escapes, not only its inner text.
const PREMATURE_CONNECTION_CLOSE_ERROR =
  '400: {"message":"data:{\\"error\\":{\\"code\\":\\"400\\",\\"message\\":\\"Request failed\\",' +
  '\\"param\\":\\"Connection prematurely closed BEFORE response\\",\\"type\\":\\"\\"},' +
  '\\"request_id\\":\\"0ddb…\\"}}","type":"invalid_request_error"}';

async function unknownAssistantErrorWaitScenario() {
  const errors = [
    PREMATURE_CONNECTION_CLOSE_ERROR,
    "Connection prematurely closed BEFORE response",
    "CONNECTION PREMATURELY CLOSED BEFORE RESPONSE",
    '400: {"message":"Connection prematurely closed BEFORE response"}',
    "Stream prematurely ended",
    "Premature end",
    // Historical PR #1324 classes that Pi does not classify as native retryable errors.
    "Upstream stream ended before terminal chunk",
    "stream closed before the response completed",
    "Premature close",
    "Incomplete response received from application",
    "Unexpected end of response body",
    "400: invalid_request_error: unsupported parameter",
    "Unauthorized: invalid API key",
    "Permission denied by remote service",
    "multi-auth rotation failed: 2 credentials tried",
    'HTTP 429: {"code":1308}',
    "",
    "   ",
    undefined,
  ];
  for (const [index, errorMessage] of errors.entries()) {
    const message = providerError(errorMessage);
    assert.equal(isRetryableAssistantError(message), false, errorMessage);
    assert.equal(isContextOverflow(message), false, errorMessage);
    const harness = await createHarness([message, completionResponse], {}, undefined, undefined, {
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
    });
    try {
      await harness.session.prompt(`/goal unknown assistant error ${index} smoke`);
      await waitForSettlement(harness, `unknown assistant error ${index} settlement`);
      assertNativeRetries(harness, [], false);
      const waitingGoal = assertQuietErrorWait(harness, 1, /\S/u);
      assert.doesNotMatch(waitingGoal.waiting.reason, /retries exhausted/i);
      assert.equal(
        harness.sdkEvents.find((event) => event.type === "message_end" && event.message.role === "assistant")?.message
          .errorMessage,
        errorMessage,
        "provider error text must remain unchanged",
      );
      await harness.session.prompt("Check again and complete the same Goal.");
      await harness.session.waitForIdle();
      assert.equal(harness.faux.state.callCount, 2, "external input alone must wake the provider wait");
      assert.equal(persistedGoalStatus(harness.session), null);
      assert.deepEqual(
        new Set(persistedGoalHistory(harness.session).map((goal) => goal.id)),
        new Set([waitingGoal.id]),
      );
      assert.deepEqual(
        harness.sdkEvents.filter((event) => event.type === "agent_settled").map((event) => event.providerCalls),
        [1, 2],
      );
      assert.equal(continuationMessages(harness.session).length, 0);
      assertNativeRetries(harness, [], false);
    } finally {
      await harness.cleanup();
    }
  }
  console.log(
    `unknown assistant waits: ${errors.length} cases, each requests=1 settlements=[1] retries=0; same-ID completion requests=2 settlements=[1,2]`,
  );
}

async function managedUnknownErrorWaitScenario() {
  for (const outcome of ["complete", "cancel"]) {
    const harness = await createHarness(
      [providerError("Unauthorized: invalid API key"), completionResponse],
      {},
      undefined,
      { rpc: { enabled: true } },
      { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
      { runId: crypto.randomUUID(), objective: `retain managed unknown-error ownership until ${outcome}` },
    );
    try {
      await waitForSettlement(harness, `managed unknown-error ${outcome} wait`);
      const waitingGoal = assertQuietErrorWait(harness, 1, /\S/u);
      assertNativeRetries(harness, [], false);
      assert.deepEqual(managedRunStatuses(harness), ["active"], "waiting must retain managed ownership");
      if (outcome === "complete") await harness.session.prompt("Complete the managed Goal now.");
      else harness.cancelManagedRun("Cancel the unknown-error wait.");
      await waitFor(() => harness.managedRunEvents.length === 2, `managed unknown-error ${outcome} terminal`);
      await harness.session.waitForIdle();
      assert.deepEqual(managedRunStatuses(harness), ["active", outcome === "complete" ? "complete" : "paused"]);
      assert.equal(
        harness.managedRunEvents.filter((event) => event.type === "state" && event.status !== "active").length,
        1,
      );
      assert.ok(harness.managedRunEvents.every((event) => event.goalId === waitingGoal.id));
      assert.equal(harness.faux.state.callCount, outcome === "complete" ? 2 : 1);
      assert.equal(harness.faux.getPendingResponseCount(), outcome === "complete" ? 0 : 1);
      assert.equal(persistedGoalStatus(harness.session), outcome === "complete" ? null : "paused");
      assert.equal(continuationMessages(harness.session).length, 0);
    } finally {
      await harness.cleanup();
    }
  }
  console.log(
    "managed unknown waits: active ownership retained; completion requests=2, cancellation requests=1; one terminal each",
  );
}

async function unknownErrorFullAbortScenario() {
  const harness = await createHarness([providerError("Invalid request"), completionResponse]);
  let abort;
  const unsubscribe = harness.session.subscribe((event) => {
    if (event.type === "agent_end") abort = harness.session.abort();
  });
  try {
    await harness.session.prompt("/goal cancel unknown error before settlement");
    await waitForSettlement(harness, "unknown-error full abort settlement");
    await abort;
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(persistedGoalState(harness.session)?.goal?.waiting, undefined);
    assert.equal(harness.faux.state.callCount, 1);
    assert.equal(harness.faux.getPendingResponseCount(), 1);
    assert.equal(continuationMessages(harness.session).length, 0);
    assertNativeRetries(harness, [], false);
    assert.deepEqual(
      harness.sdkEvents.filter((event) => event.type === "agent_settled").map((event) => event.aborted),
      [true],
    );
  } finally {
    unsubscribe();
    await harness.cleanup();
  }
}

async function unknownErrorSafetyScenario() {
  for (const hardCap of [true, false]) {
    const harness = await createHarness(
      [
        ...(hardCap ? [fauxAssistantMessage("Initial unfinished result.")] : []),
        providerError("Invalid request"),
        completionResponse,
      ],
      {},
      undefined,
      { continuationLimits: { automaticTurns: 1, noProgressTurns: null } },
      { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
    );
    try {
      await harness.session.prompt(
        hardCap ? "/goal bound unknown automatic errors" : "/goal --tokens 1 bound unknown error usage",
      );
      await waitFor(
        () => persistedGoalStatus(harness.session) === (hardCap ? "paused" : "budget_limited"),
        "unknown-error safety stop",
      );
      await harness.session.waitForIdle();
      const goal = persistedGoalState(harness.session)?.goal;
      assert.equal(goal.waiting, undefined, "unknown-error waiting must not bypass safety stops");
      assert.equal(harness.faux.state.callCount, hardCap ? 2 : 1);
      assert.equal(harness.faux.getPendingResponseCount(), 1);
      assert.equal(continuationMessages(harness.session).length, hardCap ? 1 : 0);
      assertNativeRetries(harness, [], false);
      if (hardCap) {
        assert.equal(goal.safetyPauseCause, "continuation_limit");
        assert.equal(goal.automaticModelTurns, 1);
      } else assert.ok(goal.tokensUsed >= goal.tokenBudget);
    } finally {
      await harness.cleanup();
    }
  }
}

async function unknownErrorThresholdCompactionScenario() {
  for (const outcome of ["success", "failure", "abort"]) {
    let summaryStarted = false;
    const harness = await createHarness(
      [
        () => {
          harness.session.setAutoCompactionEnabled(true);
          return providerError("Invalid request");
        },
        async (_context, options) => {
          summaryStarted = true;
          if (outcome === "abort" && !options.signal.aborted) {
            await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
          }
          return outcome === "failure"
            ? providerError("Invalid summary request")
            : fauxAssistantMessage("Compacted prior work.");
        },
        completionResponse,
      ],
      {},
      seedCompactionHistory,
      undefined,
      {
        compaction: { enabled: false, reserveTokens: 100_000 },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      },
    );
    try {
      await harness.session.prompt(`/goal unknown-error threshold compaction ${outcome}`);
      await waitFor(() => summaryStarted, `unknown-error threshold ${outcome} summary`);
      if (outcome === "abort") harness.session.abortCompaction();
      await waitForSettlement(harness, `unknown-error threshold ${outcome} settlement`);
      assertNativeRetries(harness, [], false);
      const goal = persistedGoalState(harness.session)?.goal;
      if (outcome === "abort") {
        assert.equal(goal?.status, "paused");
        assert.equal(goal.waiting, undefined);
      } else assertQuietErrorWait(harness, 2, /\S/u);
      assert.equal(harness.faux.state.callCount, 2, "threshold compaction must not trigger another provider turn");
      assert.deepEqual(
        harness.sdkEvents.filter((event) => event.type === "agent_settled").map((event) => event.providerCalls),
        [2],
      );
      assert.equal(harness.faux.getPendingResponseCount(), 1);
      assert.equal(continuationMessages(harness.session).length, 0);
      assert.deepEqual(new Set(persistedGoalHistory(harness.session).map((entry) => entry.id)), new Set([goal.id]));
      assert.deepEqual(
        harness.compactionEvents.map((event) => [event.type, event.reason, event.willRetry]),
        [
          ["session_before_compact", "threshold", false],
          [outcome === "success" ? "session_compact" : "session_compact_failed", "threshold", false],
        ],
      );
    } finally {
      await harness.cleanup();
    }
  }
  console.log(
    "unknown-error threshold compaction: success/failure wait, abort pauses; each requests=2 settlements=[2] retries=0 continuations=0",
  );
}

async function nativeBackoffAbortScenario(cancellation) {
  const retryOnly = cancellation === "retry";
  const harness = await createHarness(
    [
      fauxAssistantMessage("Initial unfinished result."),
      providerError("HTTP 524: upstream timeout"),
      completionResponse,
    ],
    {},
    undefined,
    { rpc: { enabled: true }, continuationLimits: { automaticTurns: 4, noProgressTurns: null } },
    { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
    { runId: crypto.randomUUID(), objective: `cancel ${cancellation} during native backoff without another assistant` },
  );
  try {
    // auto_retry_start precedes the native sleep controller; wait for the public backoff state.
    await waitFor(() => harness.session.isRetrying, "native backoff ready");
    assert.equal(harness.faux.state.callCount, 2);
    assert.equal(persistedGoalStatus(harness.session), "active");
    assert.equal(harness.sdkEvents.filter((event) => event.type === "agent_settled").length, 1);
    if (retryOnly) {
      harness.session.abortRetry();
      await harness.session.waitForIdle();
    } else {
      await harness.session.abort();
    }
    assertNativeRetries(harness, [1], false, 1);
    assert.equal(harness.faux.state.callCount, 2, "cancellation must not start a retry or Goal continuation");
    assert.equal(harness.faux.getPendingResponseCount(), 1);
    const goal = persistedGoalState(harness.session)?.goal;
    assert.equal(
      goal?.status,
      retryOnly ? "active" : "paused",
      "retry-only cancellation preserves waiting; full abort pauses",
    );
    assert.equal(Boolean(goal.waiting), retryOnly);
    assert.equal(goal.waiting?.resumeAt, undefined);
    assert.equal(goal.automaticModelTurns, 1);
    assert.deepEqual(
      harness.sdkEvents
        .filter((event) => event.type === "message_end" && event.message.role === "assistant")
        .map((event) => event.message.stopReason),
      ["stop", "error"],
      "backoff abort must be handled without a new aborted assistant message",
    );
    assert.deepEqual(
      harness.sdkEvents.filter((event) => event.type === "agent_settled").map((event) => event.aborted),
      [false, !retryOnly],
    );
    assert.equal(continuationMessages(harness.session).length, 1);
    assert.deepEqual(managedRunStatuses(harness), retryOnly ? ["active"] : ["active", "paused"]);
    assert.equal(harness.session.isRetrying, false);
    assert.equal(harness.session.pendingMessageCount, 0);
  } finally {
    await harness.cleanup();
  }
}

async function managedNativeRetryWaitScenario() {
  const harness = await createHarness(
    [
      fauxAssistantMessage("Initial unfinished result."),
      ...Array.from({ length: 3 }, () => providerError("HTTP 524: upstream timeout")),
      completionResponse,
    ],
    {},
    undefined,
    { rpc: { enabled: true }, continuationLimits: { automaticTurns: 5, noProgressTurns: null } },
    { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
    { runId: crypto.randomUUID(), objective: "retain managed ownership through native exhaustion" },
  );
  try {
    await waitFor(() => persistedGoalState(harness.session)?.goal?.waiting, "managed provider exhaustion wait");
    await harness.session.waitForIdle();
    assertNativeRetries(harness, [1, 2], false, 1);
    const waitingGoal = persistedGoalState(harness.session)?.goal;
    assert.equal(waitingGoal?.status, "active");
    assert.equal(waitingGoal.automaticModelTurns, 3, "every native attempt retains automatic ownership");
    assert.equal(waitingGoal.waiting.resumeAt, undefined);
    assert.equal(harness.faux.state.callCount, 4);
    assert.equal(continuationMessages(harness.session).length, 1);
    assert.deepEqual(managedRunStatuses(harness), ["active"]);
    harness.cancelManagedRun("Cancel the waiting managed run.");
    await waitFor(() => harness.managedRunEvents.length === 2, "one managed cancellation terminal");
    await harness.session.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.deepEqual(managedRunStatuses(harness), ["active", "paused"]);
    assert.ok(harness.managedRunEvents.every((event) => event.goalId === waitingGoal.id));
    assert.equal(harness.faux.state.callCount, 4, "managed cancellation must not wake provider work");
    assert.equal(harness.faux.getPendingResponseCount(), 1);
    assert.equal(continuationMessages(harness.session).length, 1);
  } finally {
    await harness.cleanup();
  }
}

async function queuedInputScenario() {
  const observedPrompts = [];
  const harness = await createHarness(
    [
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return fauxAssistantMessage("x".repeat(120));
      },
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return fauxAssistantMessage("Queued request handled.");
      },
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return completionResponse(context);
      },
    ],
    { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
  );
  try {
    await harness.session.prompt("/goal queued work smoke");
    await waitFor(() => harness.session.isStreaming, "initial turn streaming");
    await harness.session.prompt("queued user work", { streamingBehavior: "followUp" });
    await waitFor(() => harness.faux.state.callCount === 3, "continuation after queued input");
    await harness.session.agent.waitForIdle();
    const queuedIndex = observedPrompts.findIndex((text) => text.includes("queued user work"));
    const continuationIndex = observedPrompts.findIndex((text) => text.includes("pi-goal-continuation:"));
    assert.ok(queuedIndex >= 0, "expected queued work to reach the model");
    assert.ok(continuationIndex > queuedIndex, "continuation must yield to queued work");
  } finally {
    await harness.cleanup();
  }
}

async function busyEditOwnershipScenario() {
  const harness = await createHarness(
    [
      fauxAssistantMessage("x".repeat(120)),
      fauxAssistantMessage("Edited objective handled in the current run."),
      completionResponse,
    ],
    { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
  );
  try {
    await harness.session.prompt("/goal original busy objective");
    await waitFor(() => harness.session.isStreaming, "busy goal turn");
    await harness.session.prompt("/goal edit revised busy objective");
    await waitFor(() => harness.faux.state.callCount === 3, "edited-goal continuation");
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(
      harness.session.messages.map(userMessageText).some((text) => text.includes("updated objective supersedes")),
    );
  } finally {
    await harness.cleanup();
  }
}

async function pauseScenario() {
  const harness = await createHarness([fauxAssistantMessage("x".repeat(200))], {
    tokensPerSecond: 100,
    tokenSize: { min: 1, max: 1 },
  });
  try {
    await harness.session.prompt("/goal interrupt runtime smoke");
    await waitFor(() => harness.session.isStreaming, "goal turn streaming");
    await harness.session.prompt("/goal pause");
    await waitFor(() => !harness.session.isStreaming, "goal turn abort");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      harness.faux.state.callCount <= 1,
      "an interrupted stream may stop before Faux records its completed call",
    );
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(
      harness.session.messages.map(userMessageText).filter((text) => text.includes("pi-goal-continuation:")).length,
      0,
    );
  } finally {
    await harness.cleanup();
  }
}

async function staleBlockedToolAbortScenario() {
  const observedSignals = [];
  const harness = await createHarness([
    (context) =>
      fauxAssistantMessage(
        fauxToolCall("goal_blocked", {
          goal_id: goalIdFromContext(context),
          reason: "External permission is required.",
          evidence: "The same external permission was denied on three separate Goal turns.",
          repeated_turns: 3,
        }),
      ),
    fauxAssistantMessage(fauxToolCall("budget_probe", {})),
    (_context, options) => {
      observedSignals.push(options?.signal?.aborted === true);
      return fauxAssistantMessage("Synthetic stale-turn cleanup.");
    },
  ]);
  try {
    await harness.session.prompt("/goal stale blocked-tool runtime smoke");
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), "blocked");

    // Bypass the normal input boundary to model provider-owned stale work that
    // arrives after the interrupted goal has already installed its tool guard.
    await harness.session.agent.prompt("Simulate a stale provider-owned turn.");
    await harness.session.agent.waitForIdle();
    assert.ok(harness.faux.state.callCount <= 3, "stale guard must allow at most one cleanup call");
    assert.equal(observedSignals.includes(false), false, "any cleanup call must inherit abort");
    assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 0);
  } finally {
    await harness.cleanup();
  }
}

async function budgetBoundaryScenario() {
  const harness = await createHarness([fauxAssistantMessage(fauxToolCall("budget_probe", {}))]);
  try {
    await harness.session.prompt("/goal --tokens 1 budget boundary runtime smoke");
    await harness.session.agent.waitForIdle();
    assert.equal(harness.faux.state.callCount, 1, "budget stop must not queue another model call");
    assert.equal(
      harness.session.messages.some(
        (message) => message.role === "custom" && message.customType === "goal-budget-wrap-up",
      ),
      false,
    );
    assert.equal(persistedGoalStatus(harness.session), "budget_limited");
    assert.equal(harness.lifecycleEvents.filter((event) => event === "tool_execution_end").length, 1);
    assert.ok(
      harness.lifecycleEvents.indexOf("assistant_message_end") < harness.lifecycleEvents.indexOf("tool_execution_end"),
      "assistant message must finalize before tool_execution_end",
    );
  } finally {
    await harness.cleanup();
  }
}

async function budgetViolationScenario() {
  const harness = await createHarness([fauxAssistantMessage(fauxToolCall("budget_probe", {}))]);
  try {
    await harness.session.prompt("/goal --tokens 1 stop budget tools at runtime");
    await harness.session.agent.waitForIdle();
    assert.equal(harness.faux.state.callCount, 1, "budget guard must not queue cleanup work");
    assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 1);
    assert.equal(persistedGoalStatus(harness.session), "budget_limited");
  } finally {
    await harness.cleanup();
  }
}

async function budgetAgentEndFallbackScenario() {
  const harness = await createHarness([fauxAssistantMessage("No-tool budget response.")]);
  try {
    await harness.session.prompt("/goal --tokens 1 no-tool budget runtime smoke");
    await harness.session.agent.waitForIdle();
    assert.equal(harness.faux.state.callCount, 1);
    assert.equal(persistedGoalStatus(harness.session), "budget_limited");
  } finally {
    await harness.cleanup();
  }
}

async function managedRunRpcScenario() {
  const runId = crypto.randomUUID();
  const harness = await createHarness(
    [completionResponse],
    {},
    undefined,
    { rpc: { enabled: true } },
    {},
    { runId, objective: "complete a managed runtime run" },
  );
  try {
    await waitFor(
      () => harness.managedRunEvents.some((event) => event.status === "complete"),
      "managed run completion",
    );
    await harness.session.agent.waitForIdle();
    assert.deepEqual(
      harness.managedRunEvents.filter((event) => event.type === "state").map((event) => event.status),
      ["active", "complete"],
    );
    assert.equal(
      harness.managedRunEvents.filter((event) => event.type === "state" && event.status !== "active").length,
      1,
    );
  } finally {
    await harness.cleanup();
  }
}

async function managedRunDisabledScenario() {
  const runId = crypto.randomUUID();
  const harness = await createHarness([], {}, undefined, undefined, {}, { runId, objective: "must stay disabled" });
  try {
    await waitFor(() => harness.managedRunEvents.length > 0, "managed run disabled rejection");
    assert.deepEqual(harness.managedRunEvents, [
      {
        type: "error",
        runId,
        operation: "start",
        error: { code: "RPC_DISABLED", message: "Managed run RPC is disabled." },
      },
    ]);
    assert.equal(harness.faux.state.callCount, 0);
  } finally {
    await harness.cleanup();
  }
}

async function nativeLengthCompactionScenario() {
  for (const outcome of ["success", "failure", "abort"]) {
    const succeeded = outcome === "success";
    let summaryStarted = false;
    const summaryResponse = async (_context, options) => {
      summaryStarted = true;
      if (outcome === "abort" && !options.signal.aborted) {
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
      }
      if (outcome === "failure") return providerError("Invalid summary request");
      return fauxAssistantMessage("Compacted prior work.");
    };
    const harness = await createHarness(
      [
        fauxAssistantMessage("Initial unfinished result."),
        fauxAssistantMessage("Partial automatic response.", { stopReason: "length" }),
        summaryResponse,
        fauxAssistantMessage("Recovered automatic response."),
        completionResponse,
      ],
      {},
      seedCompactionHistory,
      { continuationLimits: { automaticTurns: 4, noProgressTurns: null } },
      { compaction: { enabled: true } },
    );
    try {
      await harness.session.prompt(`/goal native length compaction ${outcome} smoke`);
      await waitFor(() => summaryStarted, `native length ${outcome} summary request`);
      if (outcome === "abort") harness.session.abortCompaction();
      await waitFor(
        () => harness.sdkEvents.filter((event) => event.type === "agent_settled").length >= (succeeded ? 3 : 2),
        `native length ${outcome} settlement`,
      );
      await harness.session.waitForIdle();
      assert.equal(harness.faux.state.callCount, succeeded ? 5 : 3, `${outcome}: native compaction owns the retry`);
      assert.equal(harness.faux.getPendingResponseCount(), succeeded ? 0 : 2);
      assert.equal(persistedGoalStatus(harness.session), succeeded ? null : outcome === "abort" ? "paused" : "blocked");
      assert.equal(persistedGoalState(harness.session)?.goal?.waiting, undefined);
      assertNativeRetries(harness, [], false);
      const starts = harness.sdkEvents.filter((event) => event.type === "compaction_start");
      const ends = harness.sdkEvents.filter((event) => event.type === "compaction_end");
      assert.equal(starts.length, 1);
      assert.equal(starts[0].continuationCount, 1, "no continuation before native compaction");
      assert.equal(starts[0].goal?.automaticModelTurns, 1);
      assert.equal(ends.length, 1);
      assert.equal(ends[0].reason, "overflow");
      assert.equal(ends[0].aborted, outcome === "abort");
      assert.equal(harness.sdkEvents.filter((event) => event.type === "agent_settled").at(-1)?.aborted, false);
      assert.equal(ends[0].willRetry, succeeded);
      assert.equal(ends[0].continuationCount, 1, "compaction must not queue a duplicate continuation");
      assert.deepEqual(
        harness.compactionEvents.map((event) => [event.type, event.reason, event.willRetry]),
        [
          ["session_before_compact", "overflow", true],
          [succeeded ? "session_compact" : "session_compact_failed", "overflow", succeeded],
        ],
      );
      assert.equal(continuationMessages(harness.session).length, succeeded ? 2 : 1);
      assert.deepEqual(
        harness.sdkEvents.filter((event) => event.type === "agent_settled").map((event) => event.providerCalls),
        succeeded ? [1, 4, 5] : [1, 3],
      );
      assert.ok(
        persistedGoalHistory(harness.session).some((goal) => goal.automaticModelTurns === (succeeded ? 2 : 1)),
        "length compaction recovery must retain automatic accounting",
      );
    } finally {
      await harness.cleanup();
    }
  }
}

async function manualCompactionScenario() {
  const now = Date.now();
  const harness = await createHarness(
    [fauxAssistantMessage("Compacted prior work."), completionResponse],
    {},
    (sessionManager) => {
      seedCompactionHistory(sessionManager, now);
      sessionManager.appendCustomEntry("goal-state", {
        goal: {
          id: crypto.randomUUID(),
          text: "finish after manual compaction",
          status: "active",
          startedAt: now - 1_000,
          updatedAt: now - 1_000,
          iteration: 1,
          tokensUsed: 0,
          timeUsedSeconds: 1,
          baselineTokens: 0,
        },
      });
    },
  );
  const events = [];
  const unsubscribe = harness.session.subscribe((event) => events.push(event));
  try {
    await harness.session.compact("Summarize for the runtime smoke test.");
    await waitFor(
      () => harness.faux.state.callCount === 2,
      `manual-compaction continuation (${JSON.stringify({
        callCount: harness.faux.state.callCount,
        goalStatus: persistedGoalStatus(harness.session),
        isIdle: harness.session.isIdle,
        events: events.map((event) => event.type),
        extensions: harness.extensions,
        lifecycleEvents: harness.lifecycleEvents,
      })})`,
    );
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(harness.session.messages.map(userMessageText).some((text) => text.includes("pi-goal-continuation:")));
  } finally {
    unsubscribe();
    await harness.cleanup();
  }
}

await agentDirectoryIsolationScenario();
await normalContinuationScenario();
await runawayNoProgressScenario();
await automaticToolLoopLimitScenario();
await retryAtHardLimitScenario();
await automaticRetryOwnershipScenario();
await nativeRetryExhaustionScenario();
await nativeRetryClassificationScenario();
await unknownAssistantErrorWaitScenario();
await managedUnknownErrorWaitScenario();
await unknownErrorFullAbortScenario();
await unknownErrorSafetyScenario();
await unknownErrorThresholdCompactionScenario();
await explicitWaitErrorScenario();
await nativeBackoffAbortScenario("session");
await nativeBackoffAbortScenario("retry");
await managedNativeRetryWaitScenario();
await queuedInputScenario();
await busyEditOwnershipScenario();
await pauseScenario();
await staleBlockedToolAbortScenario();
await budgetBoundaryScenario();
await budgetViolationScenario();
await budgetAgentEndFallbackScenario();
await managedRunRpcScenario();
await managedRunDisabledScenario();
await nativeLengthCompactionScenario();
await manualCompactionScenario();
console.log(
  "pi-goal runtime smoke: existing lifecycle, native retry/compaction, ownership, explicit blocked-tool, and budget scenarios; unknown assistant quiet waiting, same-ID completion, managed cancellation, hard-cap/budget protection, and threshold compaction passed",
);
