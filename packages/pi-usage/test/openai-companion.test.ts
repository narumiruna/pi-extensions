import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { formatUsageReport, formatUsageStatusline } from "../src/format.js";
import type { OAuthCredentialCandidateReader } from "../src/oauth-credential-source.js";
import { OPENAI_CHATGPT_ADAPTER } from "../src/providers/openai-chatgpt.js";
import { matchingOpenAIAppBuckets } from "../src/providers/openai-companion-usage.js";
import { queryProviderUsage, resolveUsageAuth } from "../src/query.js";

const nativeModel = { provider: "openai", id: "gpt-6.1-sol", name: "GPT", baseUrl: "https://api.openai.com/v1" };
const codexModel = { ...nativeModel, provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" };
const native = {
  type: "oauth",
  access: "opaque-native-access",
  refresh: "native-refresh",
  expires: Date.now() + 3_600_000,
  clientId: "oaiapp_fixture",
  scopes: ["chatgpt.tokens.use.direct"],
};
const codexAccess = (accountId = "account-fixture") =>
  `e30.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url")}.sig`;
const codex = {
  type: "oauth",
  access: codexAccess(),
  refresh: "codex-refresh",
  expires: native.expires,
  accountId: "account-fixture",
};
const appPayload = {
  items: [
    {
      id: native.clientId,
      name: "Pi",
      allowed_usage_percent: 25,
      windows: [{ used_percent: 20, remaining_percent: 80, limit_window_seconds: 604800, reset_at: 2_000_000_000 }],
    },
  ],
};
const planPayload = {
  rate_limit: {
    primary_window: {
      used_percent: 30,
      limit_window_seconds: 18000,
      reset_at: 1_999_999_000,
    },
  },
  additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 99 } } }],
};

function setup(
  options: {
    obsoleteArgument?: boolean;
    nativeAccess?: string;
    companion?: unknown;
    source?: string;
    providerAuth?: Record<string, unknown>;
    candidates?: readonly unknown[];
    modelUrl?: string;
    clientId?: string;
  } = {},
) {
  const selected = { ...nativeModel, baseUrl: options.modelUrl ?? nativeModel.baseUrl };
  const grant = {
    ...native,
    access: options.nativeAccess ?? native.access,
    clientId: options.clientId ?? native.clientId,
  };
  const companion = Object.hasOwn(options, "companion") ? options.companion : codex;
  const calls: string[] = [];
  const ctx = createMockContext({
    model: selected,
    modelRegistry: {
      getAvailable: () => [selected, codexModel],
      getAll: () => [selected, codexModel],
      getProviderAuth: async (id: string) => {
        calls.push(id);
        return id === "openai"
          ? { source: "OAuth", auth: { apiKey: grant.access } }
          : companion
            ? {
                source: options.source ?? "OAuth",
                auth: options.providerAuth ?? { apiKey: (companion as typeof codex).access },
              }
            : undefined;
      },
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: grant.access }),
    },
  }).ctx;
  const reader: OAuthCredentialCandidateReader = (_context, id) => ({
    ok: true,
    candidates: (id === "openai" ? [grant] : (options.candidates ?? [companion])) as never[],
    offeredCount: 0,
  });
  return {
    calls,
    reader,
    resolve: () =>
      resolveUsageAuth(
        ctx,
        OPENAI_CHATGPT_ADAPTER,
        new Uint8Array(32),
        () => undefined,
        reader,
        options.obsoleteArgument,
        { openaiUseCodexUsage: true },
      ),
  };
}

test("companion readiness settles before fresh runtime auth and candidate matching", async () => {
  const state = setup();
  let release!: () => void;
  const ready = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  state.reader.waitUntilReady = async (_ctx, id) => {
    if (id === "openai") return true;
    entered();
    return ready;
  };
  const pending = state.resolve();
  await waiting;
  assert.deepEqual(state.calls, ["openai"]);
  release();
  assert.ok((await pending)?.openaiCompanion);
  assert.deepEqual(state.calls, ["openai", "openai-codex"]);
});

test("failed companion readiness is observable without resolving backend credentials", async () => {
  const state = setup();
  state.reader.waitUntilReady = async (_ctx, id) => id === "openai";
  await assert.rejects(state.resolve(), /readiness failed closed/);
  assert.deepEqual(state.calls, ["openai"]);
});

test("equivalent complete companion grants are accepted", async () => {
  const state = setup({ candidates: [codex, { ...codex }] });
  assert.ok((await state.resolve())?.openaiCompanion);
});

for (const obsoleteArgument of [undefined, false, true]) {
  test(`exported resolver ignores obsolete companion argument ${obsoleteArgument}`, async () => {
    const state = setup({ obsoleteArgument });
    assert.ok((await state.resolve())?.openaiCompanion);
    assert.deepEqual(state.calls, ["openai", "openai-codex"]);
  });
}

test("opaque native auth selects exact companion credentials and keeps registration metadata local", async () => {
  const auth = await setup().resolve();
  assert.ok(auth?.openaiCompanion);
  assert.equal(auth.openaiClientId, native.clientId);
  assert.deepEqual(auth.openaiCompanion.headers, {
    Authorization: `Bearer ${codex.access}`,
    "ChatGPT-Account-Id": codex.accountId,
  });
  assert.ok(auth.secrets.includes(codex.refresh));
  assert.ok(auth.secrets.includes(native.refresh));
  assert.ok(auth.secrets.includes(codex.accountId));
  assert.doesNotMatch(auth.fingerprint, /fixture|refresh|access/);
});

test("absent companion keeps web-only auth without network requests", async () => {
  const missing = await setup({ companion: undefined }).resolve();
  assert.ok(missing);
  assert.equal(missing.openaiCompanion, undefined);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  try {
    const report = await queryProviderUsage(
      OPENAI_CHATGPT_ADAPTER,
      missing,
      new AbortController().signal,
      1000,
      async () => undefined,
    );
    assert.equal(report.source, "openai-chatgpt-auth");
    assert.match(report.notes?.join("\n") ?? "", /login openai-codex/);
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
  }
});

for (const [label, options] of Object.entries({
  "API key": { source: "stored credential" },
  "wrong account": { candidates: [{ ...codex, accountId: "wrong" }] },
  "missing refresh": { candidates: [{ ...codex, refresh: "" }] },
  "invalid expiry": { candidates: [{ ...codex, expires: NaN }] },
  "conflicting match": { candidates: [codex, { ...codex, refresh: "different" }] },
  "incomplete duplicate": { candidates: [codex, { ...codex, accountId: null }] },
  "different access": { candidates: [{ ...codex, access: codexAccess("other") }] },
  proxy: { providerAuth: { apiKey: codex.access, baseUrl: "https://proxy.test" } },
  "removed authorization": { providerAuth: { apiKey: codex.access, headers: { Authorization: null } } },
  "ambiguous authorization": {
    providerAuth: {
      apiKey: codex.access,
      headers: { Authorization: `Bearer ${codex.access}`, authorization: "Bearer other" },
    },
  },
})) {
  test(`companion ${label} fails before network`, async () => {
    await assert.rejects(setup(options).resolve());
  });
}

test("both credentials and registration ID participate in cache identity", async () => {
  const a = await setup().resolve();
  const b = await setup({ clientId: "oaiapp_other" }).resolve();
  const c = await setup({ companion: { ...codex, access: codexAccess("other"), accountId: "other" } }).resolve();
  const d = await setup({ companion: undefined }).resolve();
  const e = await setup({ nativeAccess: "rotated-native-access" }).resolve();
  assert.equal(new Set([a?.fingerprint, b?.fingerprint, c?.fingerprint, d?.fingerprint, e?.fingerprint]).size, 5);
});

test("statusline omits app windows while reports retain app reset details without percentages", () => {
  const now = 2_000_000_000_000;
  const makeReport = (remaining: number) => ({
    providerId: "openai",
    providerName: "OpenAI",
    capturedAt: now,
    source: "openai-chatgpt-companion",
    semantics: { kind: "consumer-subscription" as const, label: "ChatGPT plan and app limits" },
    buckets: [
      {
        id: "plan",
        groupId: "chatgpt-plan",
        label: "Plan",
        remaining: 96,
        unit: "percent" as const,
        resetsAt: now / 1000 + 570000,
        windowMinutes: 10080,
      },
      {
        id: "app:weekly",
        groupId: "chatgpt-app",
        label: "App",
        used: 100 - remaining,
        remaining,
        unit: "percent" as const,
        resetsAt: now / 1000 + 576000,
        windowMinutes: 10080,
      },
      {
        id: "app:short",
        groupId: "chatgpt-app",
        label: "App",
        used: 100 - remaining,
        remaining,
        unit: "percent" as const,
        windowMinutes: 300,
      },
    ],
    metrics: [{ id: "app-allowance", label: "App allowance", value: 25, unit: "percent" as const }],
  });
  const first = makeReport(99);
  const second = makeReport(91);
  assert.equal(formatUsageStatusline(first, undefined, now), "chatgpt plan 96% ↻ 6d14h");
  assert.equal(formatUsageStatusline(first, undefined, now), formatUsageStatusline(second, undefined, now));
  assert.equal(
    formatUsageStatusline(
      { ...first, buckets: first.buckets.filter((bucket) => bucket.groupId === "chatgpt-plan") },
      undefined,
      now,
    ),
    formatUsageStatusline(first, undefined, now),
  );
  for (const display of ["current", "configured"] as const) {
    const text = formatUsageReport(first, display);
    assert.equal(text, formatUsageReport(second, display));
    assert.match(text, /96% left/);
    assert.match(text, /Weekly\s+resets/);
    assert.match(text, /5h\s+Reset time unavailable/);
    assert.doesNotMatch(text.split("App limits:")[1]?.split("App allowance:")[0] ?? "", /%|█|░/);
    assert.match(text, /App allowance:\s+25%/);
  }
});

test("valid unrelated registrations need readable IDs, not unused quota fields", () => {
  const result = matchingOpenAIAppBuckets({ items: [...appPayload.items, { id: "other-app" }] }, native.clientId);
  assert.equal(result.allowance, 25);
  assert.equal(result.buckets.length, 1);
});

for (const allowance of [0, 25.5, 100]) {
  test(`app allowance ${allowance} retains its percentage unit in the report`, () => {
    const text = formatUsageReport(
      {
        providerId: "openai",
        providerName: "OpenAI",
        capturedAt: 0,
        source: "openai-chatgpt-companion",
        semantics: { kind: "consumer-subscription", label: "ChatGPT plan and app limits" },
        buckets: [],
        metrics: [{ id: "app-allowance", label: "App allowance", value: allowance, unit: "percent" }],
      },
      "current",
    );
    assert.equal(
      text
        .split("\n")
        .find((line) => line.startsWith("App allowance:"))
        ?.replace(/\s+/gu, " "),
      `App allowance: ${allowance}%`,
    );
  });
}

test("quota query uses only companion GET auth and keeps raw plan/app values, allowances and resets separate", async () => {
  const auth = await setup().resolve();
  assert.ok(auth);
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${codex.access}`);
    assert.equal((init.headers as Record<string, string>)["ChatGPT-Account-Id"], codex.accountId);
    assert.ok(!JSON.stringify(init).includes(native.access));
    return new Response(JSON.stringify(url.endsWith("/apps") ? appPayload : planPayload));
  });
  try {
    const guard = vi.fn(async () => undefined);
    const report = await queryProviderUsage(OPENAI_CHATGPT_ADAPTER, auth, new AbortController().signal, 1000, guard);
    assert.deepEqual(urls, [
      "https://chatgpt.com/backend-api/wham/usage/chatpass/apps",
      "https://chatgpt.com/backend-api/wham/usage",
    ]);
    assert.equal(report.buckets.length, 2);
    assert.deepEqual(
      report.buckets.map((b) => [b.groupId, b.remaining, b.resetsAt]),
      [
        ["chatgpt-plan", 70, 1_999_999_000],
        ["chatgpt-app", 80, 2_000_000_000],
      ],
    );
    assert.equal(report.metrics.find((m) => m.id === "app-allowance")?.value, 25);
    const text = formatUsageReport(report, "current");
    assert.match(text, /Plan limits/);
    assert.match(text, /App limits/);
    assert.doesNotMatch(text.split("App limits:")[1]?.split("App allowance:")[0] ?? "", /%|█|░/);
    assert.match(text, /App allowance:\s+25%/);
    assert.match(text, /companion/i);
    assert.doesNotMatch(text, /oaiapp_fixture|account-fixture/);
    const status = formatUsageStatusline(report);
    assert.match(status ?? "", /^chatgpt plan 70% ↻ [\ddhms]+$/);
    assert.match(
      formatUsageStatusline({
        ...report,
        buckets: report.buckets.map((bucket) => ({ ...bucket, remaining: undefined })),
      }) ?? "",
      /^chatgpt plan unavailable ↻ [\ddhms]+$/,
    );
    assert.ok(guard.mock.calls.length >= 3);
  } finally {
    vi.unstubAllGlobals();
  }
});

for (const [label, payload] of Object.entries({
  "null registration": { items: [...appPayload.items, null] },
  "array registration": { items: [...appPayload.items, []] },
  "numeric registration": { items: [...appPayload.items, 7] },
  "boolean registration": { items: [...appPayload.items, true] },
  "string registration": { items: [...appPayload.items, "unreadable"] },
  "missing registration ID": { items: [...appPayload.items, {}] },
  "null registration ID": { items: [...appPayload.items, { id: null }] },
  "numeric registration ID": { items: [...appPayload.items, { id: 7 }] },
  "array registration ID": { items: [...appPayload.items, { id: [] }] },
  "empty registration ID": { items: [...appPayload.items, { id: "" }] },
  "blank registration ID": { items: [...appPayload.items, { id: " " }] },
  "unknown pagination": { ...appPayload, next: "page2" },
  "oversized list": { items: Array.from({ length: 129 }, () => appPayload.items[0]) },
  "contradictory remaining": {
    items: [
      { ...appPayload.items[0], windows: [{ used_percent: 20, remaining_percent: 99, limit_window_seconds: 60 }] },
    ],
  },
  "invalid allowance": { items: [{ ...appPayload.items[0], allowed_usage_percent: 101 }] },
  missing: { items: [] },
  duplicate: { items: [...appPayload.items, ...appPayload.items] },
  "name only": { items: [{ ...appPayload.items[0], id: "other" }] },
  "incomplete page": { ...appPayload, has_more: true },
  "next cursor": { ...appPayload, next_cursor: "opaque" },
  "missing windows": { items: [{ ...appPayload.items[0], windows: [] }] },
  "invalid used": {
    items: [{ ...appPayload.items[0], windows: [{ ...appPayload.items[0].windows[0], used_percent: -1 }] }],
  },
})) {
  test(`app ${label} never publishes unrelated plan quota`, async () => {
    const auth = await setup().resolve();
    assert.ok(auth);
    const fetch = vi.fn(
      async (url: string) => new Response(JSON.stringify(url.endsWith("/apps") ? payload : planPayload)),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      await assert.rejects(
        queryProviderUsage(OPENAI_CHATGPT_ADAPTER, auth, new AbortController().signal, 1000, async () => undefined),
      );
      assert.equal(fetch.mock.calls.length, 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
}
