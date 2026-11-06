import assert from "node:assert/strict";
import { type AssistantMessage, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { type AgentStopReason, isGoalContextOverflow, isRetryableGoalInterruption } from "../src/errors.js";

type TestAssistant = AssistantMessage & { stopReason: AgentStopReason };

function assistant(overrides: Partial<TestAssistant> = {}): TestAssistant {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: 0,
    ...overrides,
  };
}

// Cover each native decision class, including exclusions and wording that Goal
// previously accepted or vetoed. Expected eligibility comes from the public helpers.
test.each([
  "overloaded",
  "server_busy",
  "servers are currently busy",
  "currently experiencing high demand",
  "model is at capacity",
  "rate_limit_exceeded",
  "Too many requests",
  ...[429, 500, 502, 503, 504, 520, 524].map((status) => `HTTP ${status}: backend failure`),
  "The service is temporarily unavailable",
  "server error",
  "internal error",
  "Provider returned error",
  "The upstream provider returned an error",
  "exceeded request buffer limit while retrying upstream",
  "unable to forward upstream",
  "upstream request failed",
  "upstream_stream_read_error",
  "stream was interrupted",
  "HTTP/2 stream failed",
  "network error",
  "connection error",
  "connection refused",
  "connection lost",
  "other side closed",
  "fetch failed",
  "request to https://example.invalid failed, reason:",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "upstream connect",
  "reset before headers",
  "socket hang up",
  "socket connection was closed",
  "request timed out",
  "timeout",
  "terminated",
  "WebSocket closed 1000",
  "WebSocket error",
  "stream ended without a result",
  "Anthropic stream ended before message_stop",
  "stream ended before a terminal response event",
  "http2 request did not get a response",
  "stream disconnected before completion: stream closed before response.completed",
  "pending stream has been canceled",
  "retry delay exceeds configured maximum",
  "You can retry your request",
  "try your request again",
  "please retry your request",
  "ResourceExhausted: transient backend capacity",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
  "Usage limit reached: HTTP 429",
  "Quota exhausted: ResourceExhausted",
  "Credit balance depleted: server error 503",
  "Payment required: please retry your request",
  "Unauthorized: network error",
  "Unauthorised: HTTP 503",
  "Invalid API key: timeout",
  "Multi-auth rotation failed: upstream connect",
  "2 credentials tried: HTTP 500",
  "HTTP 429: GoUsageLimitError",
  "HTTP 429: FreeUsageLimitError",
  "HTTP 429: Monthly usage limit reached",
  "HTTP 429: enable available balance",
  "HTTP 429: insufficient_quota",
  "HTTP 429: out of budget",
  "HTTP 429: quota exceeded",
  "HTTP 503: billing failure",
  "HTTP 429: subscription_sharing_usage_limit_exceeded",
  "HTTP 429: subscription_sharing_workplace_individual_usage_limit_exceeded",
  'HTTP 429: {"code":1308}',
  'HTTP 429: {"code":"1308"}',
  'HTTP 429: {"code":13080}',
  "request id x500y",
  "request id 15000",
  "request id _500_",
  "request id (500)",
  "Connection prematurely closed BEFORE response",
  "CONNECTION PREMATURELY CLOSED BEFORE RESPONSE",
  '400: {"message":"Connection prematurely closed BEFORE response"}',
  "Stream prematurely ended",
  "Premature close",
  "Premature end",
  "Upstream stream ended before terminal chunk",
  "stream closed before the response completed",
  "Incomplete response received from application",
  "Unexpected end of response body",
  "Permission denied by remote service",
  "400: invalid_request_error: unsupported parameter",
  "prompt is too long: 213462 tokens > 200000 maximum",
  "context_length_exceeded",
  "HTTP 503: prompt too long",
  "HTTP 429: too many tokens",
  "Throttling error: Too many tokens",
  "",
  undefined,
])("Goal recovery eligibility matches Pi for %s", (errorMessage) => {
  const message = assistant({ errorMessage });
  assert.equal(isGoalContextOverflow(message), isContextOverflow(message));
  assert.equal(isRetryableGoalInterruption(message), isContextOverflow(message) || isRetryableAssistantError(message));
});

test.each(["stop", "length", "toolUse", "aborted"] as const)(
  "retry wording cannot make a %s response retryable",
  (stopReason) => {
    for (const errorMessage of ["HTTP 503", "prompt too long", "Usage limit reached: HTTP 429", undefined]) {
      const message = assistant({ stopReason, errorMessage });
      assert.equal(isRetryableGoalInterruption(message), false);
      assert.equal(isGoalContextOverflow(message), isContextOverflow(message));
    }
  },
);

test.each(["cerebras", "openai"] as const)(
  "provider-specific overflow classification matches Pi for %s",
  (provider) => {
    for (const errorMessage of [
      "400 status code (no body)",
      "413 (no body)",
      "rate limit: too many tokens",
      "503: prompt too long",
    ]) {
      const message = assistant({ provider, errorMessage });
      assert.equal(isGoalContextOverflow(message), isContextOverflow(message));
      assert.equal(
        isRetryableGoalInterruption(message),
        isContextOverflow(message) || isRetryableAssistantError(message),
      );
    }
  },
);

test("missing stop reason cannot create a retry", () => {
  assert.equal(isRetryableGoalInterruption({ role: "assistant", errorMessage: "HTTP 503" }), false);
});
