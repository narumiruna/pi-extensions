import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { transformSync } from "esbuild";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { usageApiRuntime } from "./fixtures/usage-api-runtime.js";

type Example = (pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext, signal: AbortSignal) => Promise<unknown>;
function example(): Example {
  const markdown = readFileSync(join(process.cwd(), "packages/pi-usage/docs/api/usage-v1.md"), "utf8");
  const code = [...markdown.matchAll(/```typescript\n([\s\S]*?)\n```/g)]
    .map((match) => match[1])
    .find((block) => block?.includes("export function readCurrentUsage"));
  assert.ok(code);
  const script = transformSync(code, { loader: "ts", format: "iife", globalName: "usageExample" }).code;
  return runInNewContext(`${script}\nusageExample.readCurrentUsage`, {
    AbortController,
    setTimeout,
    clearTimeout,
  }) as Example;
}

test("the documented transport returns no-service immediately and clears its deadline", async () => {
  vi.useFakeTimers();
  try {
    const mock = createMockPi();
    const context = createMockContext({ mode: "json" });
    const result = (await example()(mock.pi, context.ctx, new AbortController().signal)) as { reason: string };
    assert.equal(result.reason, "no-service");
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test("the documented transport accepts only a synchronous first offer and observes late rejection", async () => {
  const mock = createMockPi();
  const pi = mock.pi as ExtensionAPI;
  const offers: boolean[] = [];
  pi.events.on("usage:query:v1", (value) => {
    const request = value as { respond(result: unknown): boolean };
    offers.push(request.respond(Promise.resolve("untrusted-value")));
    offers.push(request.respond(Promise.reject(new Error("ignored duplicate"))));
    void Promise.resolve().then(() => {
      offers.push(request.respond(Promise.reject(new Error("ignored late offer"))));
    });
  });
  const result = await example()(pi, createMockContext({ mode: "json" }).ctx, new AbortController().signal);
  // The documented transport deliberately returns unknown; the consumer must validate it.
  assert.equal(result, "untrusted-value");
  assert.deepEqual(offers, [true, false, false]);
});

test("the documented deadline aborts service work and releases timers", async () => {
  vi.useFakeTimers();
  try {
    const mock = createMockPi();
    const pi = mock.pi as ExtensionAPI;
    let signal: AbortSignal | undefined;
    pi.events.on("usage:query:v1", (value) => {
      const request = value as { signal: AbortSignal; respond(result: unknown): boolean };
      signal = request.signal;
      request.respond(new Promise(() => undefined));
    });
    const pending = example()(pi, createMockContext({ mode: "json" }).ctx, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_000);
    assert.equal(((await pending) as { reason: string }).reason, "timeout");
    assert.equal(signal?.aborted, true);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test("the documented consumer obtains a real API report without importing the extension", async () => {
  const runtime = await usageApiRuntime();
  try {
    Object.assign(runtime.currentModel, runtime.providerModel);
    const result = (await example()(runtime.pi, runtime.ctx, new AbortController().signal)) as { status: string };
    assert.equal(result.status, "ready");
    assert.equal(runtime.fetches.length, 1);
  } finally {
    await runtime.close();
  }
});
