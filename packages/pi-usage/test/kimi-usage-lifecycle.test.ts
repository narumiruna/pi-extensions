import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test, vi } from "vitest";
import { deferred, usageApiRuntime } from "./fixtures/usage-api-runtime.js";

initTheme("dark", false);
const model = { id: "kimi-k2", name: "Kimi", provider: "kimi-coding", baseUrl: "http://127.0.0.1:8712/v1" };
const envName = "PI_USAGE_KIMI_CODING_API_KEY";

afterEach(() => {
  vi.unstubAllEnvs();
});

function response(used = 2) {
  return new Response(
    JSON.stringify({ usage: { used, limit: 10, window: { duration: 7, timeUnit: "TIME_UNIT_DAY" } } }),
  );
}

async function setup() {
  vi.stubEnv(envName, "");
  const runtime = await usageApiRuntime({ mode: "rpc", model });
  Object.assign(runtime.currentModel, runtime.providerModel);
  await runtime.settings.update({ kimiCodingUsageApiKey: "old-file-key" });
  runtime.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    throw new Error("Proxy auth must remain unread");
  };
  runtime.onFetch(async () => response());
  return runtime;
}

test("the extension reads JSON credentials, follows environment precedence, and fails closed after clear", async () => {
  const runtime = await setup();
  try {
    const first = await runtime.query({ refresh: true });
    assert.equal(first.status, "ready");
    assert.equal(runtime.fetches.length, 1);
    assert.equal(new Headers(runtime.fetches[0]?.init.headers).get("Authorization"), "Bearer old-file-key");
    await runtime.settings.update({ kimiCodingUsageApiKey: "new-file-key" });
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    assert.equal(new Headers(runtime.fetches.at(-1)?.init.headers).get("Authorization"), "Bearer new-file-key");
    vi.stubEnv(envName, "environment-key");
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    assert.equal(new Headers(runtime.fetches.at(-1)?.init.headers).get("Authorization"), "Bearer environment-key");
    await runtime.settings.update({ kimiCodingUsageApiKey: undefined });
    assert.equal(
      (await runtime.query({ refresh: true })).status,
      "ready",
      "clearing a file must not remove an environment override",
    );
    vi.stubEnv(envName, " ");
    const sent = runtime.fetches.length;
    const cleared = await runtime.query({ refresh: true });
    assert.equal(cleared.status, "unavailable");
    assert.equal(runtime.fetches.length, sent);
    assert.equal(runtime.authCalls(), 0);
    assert.ok(
      runtime.fetches.every(
        ({ input, init }) => input === "https://api.kimi.com/coding/v1/usages" && init.redirect === "error",
      ),
    );
    assert.equal(runtime.ctx.model?.baseUrl, model.baseUrl);
    assert.deepEqual(runtime.mock.sentMessages, []);
    assert.deepEqual(runtime.mock.entries, []);
  } finally {
    await runtime.close();
  }
});

for (const change of ["rotate-file", "clear-file", "environment-override"] as const) {
  test(`an API response cannot publish after ${change}`, async () => {
    const runtime = await setup();
    const entered = deferred<void>();
    const returned = deferred<Response>();
    runtime.onFetch(async () => {
      entered.resolve();
      return returned.promise;
    });
    const pending = runtime.query({ refresh: true });
    try {
      await entered.promise;
      if (change === "environment-override") vi.stubEnv(envName, "environment-key");
      else
        await runtime.settings.update({ kimiCodingUsageApiKey: change === "rotate-file" ? "new-file-key" : undefined });
      returned.resolve(response());
      assert.equal((await pending).status, "unavailable");
      assert.equal(
        runtime.changes.some(({ reason }) => reason === "updated"),
        false,
      );
      assert.equal(runtime.context.statuses.get("usage"), undefined);
      if (change !== "clear-file") {
        runtime.onFetch(async () => response(8));
        const current = await runtime.query({ refresh: true });
        assert.equal(current.status, "ready");
        if (current.status === "ready") assert.equal(current.report.buckets[0]?.used, 8);
      }
    } finally {
      returned.resolve(response());
      await pending;
      await runtime.close();
    }
  });
}

for (const boundary of ["cancel", "model_select", "session_start", "session_shutdown"] as const) {
  test(`Kimi readiness work stops before HTTP on ${boundary}`, async () => {
    const runtime = await setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    runtime.pi.events.on("oauth:credential-readiness:v1", (raw) => {
      const request = raw as { provider: string; waitUntil(value: Promise<void>): void };
      if (request.provider === "kimi-coding") {
        entered.resolve();
        request.waitUntil(release.promise);
      }
    });
    const controller = new AbortController();
    const pending = runtime.query({ refresh: true, signal: controller.signal });
    try {
      await entered.promise;
      if (boundary === "cancel") controller.abort();
      else {
        if (boundary === "model_select" || boundary === "session_start") {
          Object.assign(runtime.ctx, { model: { ...model, provider: "other" } });
        }
        await runtime.emit(boundary);
      }
      assert.equal((await pending).status, "unavailable");
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runtime.fetches.length, 0);
      assert.equal(runtime.authCalls(), 0);
    } finally {
      controller.abort();
      release.resolve();
      await pending;
      await runtime.close();
    }
  });
}

test("an API request waiting for publication cannot adopt a Kimi account changed through Settings", async () => {
  const runtime = await setup();
  Object.assign(runtime.ctx, { mode: "tui" });
  const entered = deferred<void>();
  const release = deferred<void>();
  const flush = runtime.settings.flush.bind(runtime.settings);
  vi.spyOn(runtime.settings, "flush").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    await flush();
  });
  runtime.onFetch(async (_input, init) =>
    response(new Headers(init.headers).get("Authorization") === "Bearer new-file-key" ? 8 : 2),
  );
  const pending = runtime.query({ refresh: true });
  await entered.promise;
  let settingsOpened = false;
  let editing = false;
  runtime.ctx.ui.custom = async (factory, options) => {
    const harness = createTuiHarness({ width: 120, rows: 40, keybindings: getKeybindings() });
    const running = harness.custom(factory, options);
    try {
      await harness.waitForOpen();
      const text = stripVTControlCharacters(harness.render().join("\n"));
      if (text.includes("Provider usage")) {
        if (!settingsOpened) {
          settingsOpened = true;
          harness.send("\u001b[B");
          harness.send("\r");
        } else harness.send("\u0003");
      } else if (text.includes("pi-usage Settings")) {
        if (!editing) {
          editing = true;
          for (let row = 0; row < 5; row++) harness.send("\u001b[B");
          harness.send("\r");
          harness.send("\r");
        } else harness.send("\u0003");
      } else if (text.includes("Official Kimi usage key")) {
        harness.type("new-file-key");
        harness.send("\r");
      }
      return await running;
    } finally {
      harness.dispose();
    }
  };
  try {
    const command = runtime.mock.commands.get("usage");
    assert.ok(command);
    await command.handler("", runtime.ctx as ExtensionCommandContext);
    release.resolve();
    assert.deepEqual(await pending, { status: "unavailable", providerId: "kimi-coding", reason: "stale-context" });
    assert.equal(runtime.settings.get().settings.kimiCodingUsageApiKey, "new-file-key");
    assert.deepEqual(
      runtime.fetches.map(({ init }) => new Headers(init.headers).get("Authorization")),
      ["Bearer old-file-key", "Bearer new-file-key"],
    );
  } finally {
    release.resolve();
    await pending;
    await runtime.close();
  }
});

test("clearing the key through the real Settings action clears the current report and status", async () => {
  const runtime = await setup();
  Object.assign(runtime.ctx, { mode: "tui" });
  const frames: string[] = [];
  const statusAfterClear: Array<string | undefined> = [];
  let settingsOpened = false;
  let cleared = false;
  runtime.ctx.ui.custom = async (factory, options) => {
    const harness = createTuiHarness({ width: 120, rows: 40, keybindings: getKeybindings() });
    const running = harness.custom(factory, options);
    try {
      await harness.waitForOpen();
      const text = stripVTControlCharacters(harness.render().join("\n"));
      if (text.includes("Provider usage")) {
        frames.push(text);
        if (!settingsOpened) {
          settingsOpened = true;
          harness.send("\u001b[B");
          harness.send("\r");
        } else harness.send("\u0003");
      } else if (text.includes("pi-usage Settings")) {
        if (!cleared) {
          for (let row = 0; row < 5; row++) harness.send("\u001b[B");
          harness.send("\r");
          harness.send("\u001b[B");
          cleared = true;
          harness.send("\r");
        } else {
          statusAfterClear.push(runtime.context.statuses.get("usage"));
          harness.send("\u0003");
        }
      }
      return await running;
    } finally {
      harness.dispose();
    }
  };
  const command = runtime.mock.commands.get("usage");
  assert.ok(command);
  try {
    await command.handler("", runtime.ctx as ExtensionCommandContext);
    assert.equal(cleared, true);
    assert.equal(runtime.settings.get().settings.kimiCodingUsageApiKey, undefined);
    assert.deepEqual(statusAfterClear, [undefined]);
    assert.ok(frames[0]?.includes("80%"));
    assert.ok(frames.at(-1)?.includes("custom provider base URL"));
    assert.ok(!frames.at(-1)?.includes("80%"));
    assert.equal(runtime.context.statuses.get("usage"), "auth unavailable");
    assert.equal(runtime.fetches.length, 1);
    assert.ok(runtime.changes.some(({ reason }) => reason === "invalidated"));
  } finally {
    await runtime.close();
  }
});
