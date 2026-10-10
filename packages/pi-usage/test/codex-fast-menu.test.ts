import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import usageExtension from "../src/usage.js";

const codexModel = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

async function fixture(
  t: TestContext,
  options: {
    enabled?: boolean;
    invalid?: boolean;
    model?: typeof codexModel;
    models?: unknown[];
    offline?: boolean;
  } = {},
) {
  const model = options.model ?? codexModel;
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "menu-account" } }),
  ).toString("base64url");
  const credential = {
    type: "oauth" as const,
    access: `fixture.${payload}.signature`,
    refresh: "fixture-menu-refresh",
    expires: Date.now() + 60_000,
    accountId: "menu-account",
  };
  const directory = await mkdtemp(join(tmpdir(), "pi-fast-menu-test-"));
  const path = join(directory, "pi-usage.json");
  const originalDocument = options.invalid
    ? '{"codexFastMode":"invalid"}'
    : JSON.stringify({ codexFastMode: options.enabled ?? false });
  await writeFile(path, originalDocument);
  const settings = createUsageSettingsRuntime(path);
  await settings.reload();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/backend-api/codex/models") {
      if (options.offline) throw new TypeError("The model directory is temporarily unavailable.");
      return Response.json({ models: options.models ?? [{ slug: model.id, service_tiers: [{ id: "priority" }] }] });
    }
    assert.equal(url.pathname, "/backend-api/wham/usage");
    return Response.json({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } } });
  };
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settings, credentialReader: () => credential });
  const titles: string[] = [];
  const choices: string[] = [];
  let selection: string[] = [];
  const current = createMockContext({
    hasUI: true,
    mode: "rpc",
    model,
    select: async (title: string, values: string[]) => {
      titles.push(title);
      selection = values;
      return choices.shift();
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: credential.access }),
      getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: credential.access } }),
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: () => "OpenAI Codex",
    },
  });
  t.onTestFinished(async () => {
    try {
      for (const shutdown of mock.events.get("session_shutdown") ?? []) await shutdown({}, current.ctx);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    ...current,
    path,
    originalDocument,
    settings,
    titles,
    choices,
    get selection() {
      return selection;
    },
    open: () => mock.commands.get("usage")?.handler("", current.ctx),
  };
}

test("/usage discovers an unlisted model and toggles the same persistent Fast preference", async (t) => {
  const future = { ...codexModel, id: "future-menu-model", name: "Future Menu Model" };
  const f = await fixture(t, { model: future });
  f.choices.push("Turn Fast mode on", "Close");
  await f.open();
  assert.equal(f.settings.get().settings.codexFastMode, true);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).codexFastMode, true);
  assert.match(f.titles[0] ?? "", /Fast mode: Off/);
  assert.match(f.titles[0] ?? "", /1\.5× faster.*uses more/);
  assert.match(f.notifications[0]?.message ?? "", /Fast mode enabled/);
});

test("/usage cancellation preserves the stored Fast preference", async (t) => {
  const f = await fixture(t);
  await f.open();
  assert.ok(f.selection.includes("Turn Fast mode on"));
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
});

test.for([
  { name: "missing model", models: [], label: "Unknown" },
  { name: "missing capability fields", models: [{ slug: codexModel.id }], label: "Unknown" },
  {
    name: "explicit unsupported capability",
    models: [{ slug: codexModel.id, service_tiers: [] }],
    label: "Unavailable",
  },
])("/usage displays $name without offering an unsafe enable action", async ({ models, label }, t) => {
  const f = await fixture(t, { models });
  f.choices.push("Close");
  await f.open();
  assert.match(f.titles[0] ?? "", new RegExp(`Fast mode: ${label}`));
  assert.ok(!f.selection.includes("Turn Fast mode on"));
  assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
});

test("/usage can disable an enabled preference while discovery is unknown", async (t) => {
  const f = await fixture(t, { enabled: true, offline: true });
  f.choices.push("Turn Fast mode off", "Close");
  await f.open();
  assert.match(f.titles[0] ?? "", /Fast mode: Unknown/);
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).codexFastMode, false);
});

test("invalid settings keep /usage Fast controls visibly read-only", async (t) => {
  const f = await fixture(t, { invalid: true });
  f.choices.push("Close");
  await f.open();
  assert.match(f.titles[0] ?? "", /Fast mode: Off/);
  assert.ok(f.selection.includes("Turn Fast mode on"));
  assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
});
