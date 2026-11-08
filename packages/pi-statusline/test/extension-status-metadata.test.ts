import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  type ExtensionStatusRuntime,
  formatExtensionStatus,
  formatExtensionStatuses,
  wrapExtensionStatusline,
} from "../src/extension-status.js";
import { subscribeExtensionStatusMetadata } from "../src/extension-status-metadata.js";
import { type RuntimeState, renderExtensionStatusline, renderStatusline } from "../src/render.js";
import { DEFAULT_STATUSLINE_CONFIG as DEFAULT_CONFIG } from "../src/settings.js";
import type { StatuslineConfig } from "../src/types.js";

const UPDATE = "extension-status:v1:update";
const REQUEST = "extension-status:v1:request";
const theme = { fg: (_role: string, text: string) => text } as Theme;
const key = "arbitrary/participant";
const value = "readable participant status";

function fixture() {
  const mock = createMockPi();
  const sessionManager = {};
  const statuses = new Map([[key, value]]);
  const requests: Array<{ version: number; sessionManager: object; requestId: object }> = [];
  mock.eventBus.on(REQUEST, (data) => requests.push(data as (typeof requests)[number]));
  const requestRender = vi.fn();
  const metadata = subscribeExtensionStatusMetadata(mock.eventBus, sessionManager, () => statuses, requestRender);
  const runtime: ExtensionStatusRuntime = {
    duplicateExtensions: [],
    extensionStatusIconAliases: new Map(),
    extensionStatusMetadata: metadata,
  };
  const send = (data: unknown) => mock.eventBus.emit(UPDATE, data);
  const update = (fields: Record<string, unknown> = {}) =>
    send({ version: 1, sessionManager, key, value, activity: "checking", ...fields });
  const render = (extensionStatusIcons: Record<string, string> = {}) =>
    formatExtensionStatuses(statuses, theme, { ...DEFAULT_CONFIG, extensionStatusIcons }, runtime, undefined, false);
  return { mock, sessionManager, statuses, requests, requestRender, metadata, runtime, send, update, render };
}

for (const nested of [
  "current-snapshot",
  "wrong-token",
  "other-session",
  "other-key",
  "primitive",
  "invalid-live",
] as const) {
  test(`nested ${nested} only supersedes a relevant accepted update`, () => {
    const f = fixture();
    const otherKey = "unrelated/participant";
    f.statuses.set(otherKey, value);
    try {
      f.update({ activity: "idle" });
      const requestId = f.requests[0]?.requestId;
      assert.ok(requestId);
      f.send({
        version: 1,
        sessionManager: f.sessionManager,
        key,
        value,
        get activity() {
          if (nested === "current-snapshot") f.update({ requestId });
          else if (nested === "wrong-token") f.update({ requestId: {} });
          else if (nested === "other-session") f.update({ sessionManager: {} });
          else if (nested === "other-key") f.update({ key: otherKey });
          else if (nested === "primitive") f.send(null);
          else f.update({ version: 2 });
          return "review";
        },
      });
      assert.equal(f.metadata.get(key, value)?.activity, nested === "invalid-live" ? undefined : "review");
      if (nested === "other-key") assert.equal(f.metadata.get(otherKey, value)?.activity, "checking");
    } finally {
      f.metadata.dispose();
    }
  });
}

test("a routing getter cannot overwrite a newer accepted same-key event", () => {
  const f = fixture();
  try {
    f.update({ activity: "idle" });
    f.send({
      version: 1,
      sessionManager: f.sessionManager,
      value,
      activity: "idle",
      get key() {
        f.update({ activity: "review" });
        return key;
      },
    });
    assert.equal(f.metadata.get(key, value)?.activity, "review");
  } finally {
    f.metadata.dispose();
  }
});

test("an unstable raw-map read restores raw output without erasing a newer sibling", () => {
  const mock = createMockPi();
  const sessionManager = {};
  const otherKey = "unrelated/participant";
  const statuses = new Map([
    [key, value],
    [otherKey, "old sibling value"],
  ]);
  let reenter: (() => void) | undefined;
  const metadata = subscribeExtensionStatusMetadata(
    mock.eventBus,
    sessionManager,
    () => {
      const snapshot = new Map(statuses);
      const callback = reenter;
      reenter = undefined;
      callback?.();
      return snapshot;
    },
    () => {},
  );
  try {
    mock.eventBus.emit(UPDATE, { version: 1, sessionManager, key, value, activity: "idle" });
    reenter = () => {
      statuses.set(otherKey, "new sibling value");
      mock.eventBus.emit(UPDATE, {
        version: 1,
        sessionManager,
        key: otherKey,
        value: "new sibling value",
        activity: "review",
      });
    };
    mock.eventBus.emit(UPDATE, { version: 1, sessionManager, key, value, activity: "review" });
    assert.equal(metadata.get(key, value), undefined);
    assert.equal(metadata.get(otherKey, "new sibling value")?.activity, "review");
    metadata.reconcile(statuses);
    assert.equal(metadata.get(otherKey, "new sibling value")?.activity, "review");
  } finally {
    metadata.dispose();
  }
});

test("an observed raw replacement during parsing cannot restore the older same-value idle", () => {
  const f = fixture();
  try {
    f.update({ activity: "idle" });
    f.send({
      version: 1,
      sessionManager: f.sessionManager,
      key,
      value,
      get activity() {
        f.statuses.clear();
        f.metadata.reconcile(f.statuses);
        f.statuses.set(key, value);
        return "idle";
      },
    });
    assert.equal(f.metadata.get(key, value), undefined);
  } finally {
    f.metadata.dispose();
  }
});

for (const action of ["review", "withdraw", "dispose", "throw"] as const) {
  test(`reentrant payload ${action} cannot commit an older presentation`, () => {
    const f = fixture();
    try {
      const requestId = f.requests[0]?.requestId;
      assert.ok(requestId);
      f.send({
        version: 1,
        sessionManager: f.sessionManager,
        key,
        value,
        ...(action === "throw" ? {} : { requestId }),
        get activity() {
          if (action === "dispose") f.metadata.dispose();
          else if (action === "withdraw")
            f.send({ version: 1, sessionManager: f.sessionManager, key, value: undefined });
          else f.update({ activity: "review" });
          if (action === "throw") throw new Error("superseded malformed data");
          return "idle";
        },
      });
      assert.equal(
        f.metadata.get(key, value)?.activity,
        action === "review" || action === "throw" ? "review" : undefined,
      );
    } finally {
      f.metadata.dispose();
    }
  });
}

test("snapshot fields are read once and cannot delete a newer live presentation", () => {
  const f = fixture();
  let reads = 0;
  try {
    const requestId = f.requests[0]?.requestId;
    assert.ok(requestId);
    f.send({
      version: 1,
      sessionManager: f.sessionManager,
      key,
      requestId,
      get value() {
        reads++;
        f.update({ activity: "review" });
        return undefined;
      },
    });
    assert.equal(reads, 1);
    assert.equal(f.metadata.get(key, value)?.activity, "review");
  } finally {
    f.metadata.dispose();
  }
});

for (const action of ["review", "dispose", "throw", "iterate"] as const) {
  test(`reentrant raw-map ${action} cannot overwrite or erase a newer state`, () => {
    const mock = createMockPi();
    const sessionManager = {};
    const statuses = new Map([[key, value]]);
    let reenter: (() => void) | undefined;
    const metadata = subscribeExtensionStatusMetadata(
      mock.eventBus,
      sessionManager,
      () => {
        const callback = reenter;
        reenter = undefined;
        if (action === "iterate" && callback)
          return {
            *[Symbol.iterator]() {
              callback();
              yield* statuses;
            },
          } as ReadonlyMap<string, string>;
        callback?.();
        return statuses;
      },
      () => {},
    );
    try {
      reenter = () => {
        if (action === "dispose") metadata.dispose();
        else mock.eventBus.emit(UPDATE, { version: 1, sessionManager, key, value, activity: "review" });
        if (action === "throw") throw new Error("superseded raw-map failure");
      };
      mock.eventBus.emit(UPDATE, { version: 1, sessionManager, key, value, activity: "idle" });
      assert.equal(metadata.get(key, value)?.activity, action === "dispose" ? undefined : "review");
    } finally {
      metadata.dispose();
    }
  });
}

test.each([
  ["idle", ""],
  ["checking", "🔌 …"],
  ["working", "🔌 ↻"],
  ["pushing", "🔌 ↑"],
  ["pulling", "🔌 ↓"],
  ["resolving", "🔌 AI"],
  ["local-change", "🔌 ⇡"],
  ["remote-change", "🔌 ⇣"],
  ["review", "🔌 ⇕"],
])("generic participant activity %s uses compact body %s", (activity, expected) => {
  const f = fixture();
  try {
    f.update({ activity });
    assert.equal(f.render(), expected);
    assert.equal(f.statuses.get(key), value);
  } finally {
    f.metadata.dispose();
  }
});

test.each(["retry", "blocked"])("%s retains every safe reason with warning hierarchy", (activity) => {
  const f = fixture();
  try {
    for (const reason of [
      "temp",
      "busy",
      "stale",
      "auth",
      "storage",
      "review",
      "model",
      "limit",
      "unknown",
      "repair",
      "third-party",
      "a",
      `a${"0".repeat(31)}`,
    ]) {
      f.update({ activity, reason });
      const roles: [string, string][] = [];
      const coloredTheme = {
        fg(role: string, text: string) {
          roles.push([role, text]);
          return text;
        },
      } as Theme;
      const body = activity === "retry" ? `retry: ${reason}` : `! ${reason}`;
      assert.equal(formatExtensionStatuses(f.statuses, coloredTheme, DEFAULT_CONFIG, f.runtime), `🔌 ${body}`);
      assert.deepEqual(roles.slice(-2), [
        ["warning", body],
        ["warning", "🔌"],
      ]);
      assert.equal(f.render({ [key]: "" }), body);
    }
  } finally {
    f.metadata.dispose();
  }
});

test("nonparticipants and metadata without an exact raw key/value retain raw formatting", () => {
  const f = fixture();
  try {
    const raw = formatExtensionStatus(key, value, theme, DEFAULT_CONFIG);
    assert.equal(f.render(), raw);
    for (const fields of [
      { key: "participant" },
      { key: `${key}:slot` },
      { value: `${value} ` },
      { value: "" },
      { sessionManager: {} },
    ]) {
      f.update({ activity: "idle", ...fields });
      assert.equal(f.render(), raw);
    }
    f.update({ activity: "idle" });
    assert.equal(f.render(), "");
    f.send({ version: 1, sessionManager: f.sessionManager, key, value: undefined });
    assert.equal(f.render(), raw);
    assert.equal(f.statuses.get(key), value);
  } finally {
    f.metadata.dispose();
  }
});

const invalidFields: Record<string, unknown>[] = [
  { version: 2 },
  { version: "1" },
  { version: undefined },
  { activity: undefined },
  { activity: "unknown" },
  { activity: {} },
  { activity: "idle", reason: "auth" },
  { activity: "checking", reason: undefined },
  { activity: "retry" },
  { activity: "blocked", reason: "" },
  ...["AUTH", "two words", "a\n", "a\u001b[31m", "1auth", "-auth", "a_", "é", `a${"b".repeat(32)}`, {}, null, 1].map(
    (reason) => ({ activity: "retry", reason }),
  ),
  ...["retry", "blocked"].flatMap((activity) =>
    ["\r", "\n", "\r\n", "\u2028", "\u2029"].map((suffix) => ({ activity, reason: `auth${suffix}` })),
  ),
  { value: null },
  { value: 1 },
  { value: "different" },
];

test.each(invalidFields)("invalid current-session live data restores raw status: %j", (fields) => {
  const f = fixture();
  try {
    f.update({ activity: "idle" });
    assert.equal(f.render(), "");
    f.update(fields);
    assert.equal(f.render(), formatExtensionStatus(key, value, theme, DEFAULT_CONFIG));
    assert.equal(f.metadata.get(key, value), undefined);
    assert.equal(f.requestRender.mock.calls.length, 2);
  } finally {
    f.metadata.dispose();
  }
});

test("missing values invalidate live state; unidentifiable data cannot alter it", () => {
  const f = fixture();
  try {
    f.update({ activity: "working" });
    for (const data of [
      undefined,
      null,
      false,
      "status",
      [],
      {},
      { sessionManager: {}, key },
      { sessionManager: f.sessionManager, key: "" },
      { sessionManager: f.sessionManager, key: 1 },
    ]) {
      f.send(data);
      assert.equal(f.render(), "🔌 ↻");
    }
    f.send({ version: 1, sessionManager: f.sessionManager, key });
    assert.equal(f.render(), `🔌 ${value}`);
    f.update({ activity: "idle" });
    f.send(Object.assign([], { version: 1, sessionManager: f.sessionManager, key, value, activity: "idle" }));
    assert.equal(f.render(), `🔌 ${value}`);
  } finally {
    f.metadata.dispose();
  }
});

test("hostile payloads cannot throw or mutate cached presentations", () => {
  const f = fixture();
  try {
    const data = { version: 1, sessionManager: f.sessionManager, key, value, activity: "review" };
    f.send(Object.freeze({ ...data }));
    assert.equal(f.render(), "🔌 ⇕");
    f.send(data);
    assert.equal(Object.isFrozen(f.metadata.get(key, value)), true);
    data.activity = "idle";
    assert.equal(f.render(), "🔌 ⇕");
    f.send({
      ...data,
      get activity() {
        throw new Error("hostile getter");
      },
    });
    assert.equal(f.render(), `🔌 ${value}`);
    f.send(
      new Proxy(
        {},
        {
          get() {
            throw new Error("hostile proxy");
          },
        },
      ),
    );
    assert.equal(f.render(), `🔌 ${value}`);
  } finally {
    f.metadata.dispose();
  }
});

test("subscribe-before-request accepts only identity-equal current snapshot tokens", () => {
  const f = fixture();
  try {
    assert.equal(f.requests.length, 1);
    const request = f.requests[0];
    assert.equal(request?.version, 1);
    assert.equal(request?.sessionManager, f.sessionManager);
    assert.equal(typeof request?.requestId, "object");
    for (const requestId of [{}, null, "token", undefined]) {
      f.update({ activity: "idle", requestId });
      assert.equal(f.render(), `🔌 ${value}`);
    }
    f.update({ activity: "review", requestId: request?.requestId });
    assert.equal(f.render(), "🔌 ⇕");
    f.send({ ...request, key, value: undefined });
    assert.equal(f.render(), `🔌 ${value}`);
  } finally {
    f.metadata.dispose();
  }
});

test.each(["review", "blocked", "withdrawal", "invalid"])(
  "same-value delayed snapshots cannot replace newer live %s",
  (live) => {
    const f = fixture();
    try {
      const requestId = f.requests[0]?.requestId;
      if (live === "withdrawal") f.send({ version: 1, sessionManager: f.sessionManager, key, value: undefined });
      else if (live === "invalid") f.update({ version: 9, activity: "idle" });
      else f.update(live === "blocked" ? { activity: live, reason: "auth" } : { activity: live });
      const expected = f.render();
      f.update({ activity: "idle", requestId });
      f.send(
        Object.assign(Object.create({ requestId }), {
          version: 1,
          sessionManager: f.sessionManager,
          key,
          value,
          activity: "idle",
        }),
      );
      f.update({ version: 9, activity: "checking", requestId });
      f.send({ version: 1, sessionManager: f.sessionManager, key, value: undefined, requestId });
      assert.equal(f.render(), expected);
      assert.equal(f.statuses.get(key), value);
    } finally {
      f.metadata.dispose();
    }
  },
);

test.each(["replacement", "clear"])(
  "observed raw %s cannot reuse metadata or accept delayed same-value snapshots",
  (change) => {
    const f = fixture();
    try {
      const requestId = f.requests[0]?.requestId;
      f.update({ activity: "idle", requestId });
      assert.equal(f.render(), "");
      if (change === "replacement") f.statuses.set(key, "different raw status");
      else f.statuses.delete(key);
      f.render();
      f.statuses.set(key, value);
      assert.equal(f.render(), `🔌 ${value}`);
      f.update({ activity: "idle", requestId });
      assert.equal(f.render(), `🔌 ${value}`);
      f.update({ activity: "checking" });
      assert.equal(f.render(), "🔌 …");
    } finally {
      f.metadata.dispose();
    }
  },
);

test("raw transitions observed before any snapshot reply also fence off stale metadata", () => {
  const f = fixture();
  try {
    f.statuses.delete(key);
    f.render();
    f.statuses.set(key, value);
    f.update({ activity: "idle", requestId: f.requests[0]?.requestId });
    assert.equal(f.render(), `🔌 ${value}`);
    f.update({ activity: "review" });
    assert.equal(f.render(), "🔌 ⇕");
  } finally {
    f.metadata.dispose();
  }
});

test("hidden entries do not use visible slots or create blank separators", () => {
  const f = fixture();
  try {
    f.statuses.clear();
    for (let index = 0; index < 8; index += 1) {
      const statusKey = `participant-${index}`;
      f.statuses.set(statusKey, statusKey);
      f.update({ key: statusKey, value: statusKey, activity: index < 3 ? "idle" : "review" });
    }
    f.statuses.set("plain", "sixth visible");
    const rendered = f.render();
    assert.equal((rendered.match(/⇕/g) ?? []).length, 5);
    assert.doesNotMatch(rendered, /sixth visible/);
    assert.equal((rendered.match(/•/g) ?? []).length, 4);
    assert.ok(rendered.startsWith("🔌 ⇕"));
    assert.ok(rendered.endsWith("🔌 ⇕"));
    for (const statusKey of f.statuses.keys())
      f.update({ key: statusKey, value: f.statuses.get(statusKey), activity: "idle" });
    assert.equal(f.render(), "");
    f.runtime.duplicateExtensions = ["duplicate"];
    assert.equal(f.render(), "⚠️ dup duplicate");
  } finally {
    f.metadata.dispose();
  }
});

test("compact icon selection preserves every precedence class and empty overrides", () => {
  const f = fixture();
  try {
    f.runtime.extensionStatusIconAliases = new Map([
      ["foo", ["npm:@vendor/pi-foo@1", "npm:@vendor/pi-foo", "@vendor/pi-foo", "pi-foo", "foo"]],
    ]);
    const cases: [string, string, Record<string, string>][] = [
      ["foo:worker", "🔥 work", { "foo:worker": "EXACT", "foo:*": "WILD", "@vendor/pi-foo": "ALIAS" }],
      ["foo:worker", "foo:worker: 🔥 work", {}],
      ["foo:worker", "🇬🇧 work", {}],
      ["foo:worker", "1️⃣ work", {}],
      ["other:worker", "work", { "@vendor/pi-other": "NO" }],
      ["foo:server:worker", "🔥 work", { "foo:*": "SHORT", "foo:server:*": "LONG" }],
      ["foo:worker", "🔥 work", { "foo:*": "WILD", "@vendor/pi-foo": "ALIAS" }],
      ["foo/worker", "🔥 work", { "@vendor/pi-foo": "ALIAS" }],
      ["foo", "🔥 work", { "npm:@vendor/pi-foo@1": "VERSION", "npm:@vendor/pi-foo": "SOURCE", "pi-foo": "BASE" }],
      ["foo", "🔥 work", { "npm:@vendor/pi-foo": "SOURCE", "@vendor/pi-foo": "PACKAGE" }],
      ["foo", "🔥 work", { "pi-foo": "BASE" }],
      ["foobar", "🔥 work", { "@vendor/pi-foo": "NO" }],
      ["foo", "🔥 work", { "foo:*": "NO" }],
      ["foo/worker", "work", { "foo:*": "NO" }],
      ["retry", "work", { "unknown-error-retry": "LEGACY" }],
      ["unknown-error-retry", "work", { retry: "CANONICAL" }],
      ["retry", "work", { retry: "EXACT", "unknown-error-retry": "LEGACY" }],
      ["goal", "🔥 work", {}],
      ["goal", "work", {}],
      ["foo:worker", "🔥 work", { "foo:worker": "", "foo:*": "WILD" }],
      ["foo:worker", "🔥 work", { "foo:*": "", "@vendor/pi-foo": "ALIAS" }],
      ["foo:server:worker", "🔥 work", { "foo:*": "SHORT", "foo:server:*": "" }],
      ["goal", "🔥 work", { goal: "" }],
      ["foo/worker", "🔥 work", { "@vendor/pi-foo": "" }],
      ["retry", "🔥 work", { "unknown-error-retry": "" }],
      ["__proto__", "work", {}],
    ];
    for (const [statusKey, raw, icons] of cases) {
      f.statuses.clear();
      f.statuses.set(statusKey, raw);
      f.update({ key: statusKey, value: raw, activity: "checking" });
      const existing = formatExtensionStatus(
        statusKey,
        raw,
        theme,
        { extensionStatusIcons: icons },
        f.runtime.extensionStatusIconAliases,
      );
      const identifier = existing.endsWith(" work") ? existing.slice(0, -" work".length) : "";
      assert.equal(f.render(icons), identifier ? `${identifier} …` : "…", statusKey);
      assert.doesNotMatch(f.render(icons), /work/);
    }
  } finally {
    f.metadata.dispose();
  }
});

test("prototype keys cannot inherit a default icon or a compatibility alias", () => {
  const f = fixture();
  try {
    for (const key of ["__proto__", "constructor", "toString"]) {
      const icons = { [String(Reflect.get({}, key))]: "INHERITED" };
      f.statuses.clear();
      f.statuses.set(key, "work");
      f.update({ key, value: "work", activity: "checking" });
      assert.equal(formatExtensionStatus(key, "work", theme, { extensionStatusIcons: icons }), "🔌 work");
      assert.equal(f.render(icons), "🔌 …");
    }
  } finally {
    f.metadata.dispose();
  }
});

test("compact rendering strips hostile terminal data without changing identities or raw PR links", () => {
  const f = fixture();
  try {
    const hostileKey = "\u001b[31mfoo\u001b[0m";
    const raw = "\u001b]8;;https://example.test\u0007🔥\u001b]8;;\u0007 work\u001b[2J\u0000\u202e";
    f.statuses.clear();
    f.statuses.set(hostileKey, raw);
    f.update({ key: hostileKey, value: raw, activity: "review" });
    assert.equal(f.render(), "🔥 ⇕");
    assert.equal(f.render({ [hostileKey]: "\u001b[2J\u009dtitle\u009c🧪\u202e" }), "🧪 ⇕");
    assert.equal(f.statuses.get(hostileKey), raw);
    assert.equal(f.metadata.get("foo", raw), undefined);
    assert.equal(f.metadata.get(hostileKey, "🔥 work"), undefined);
    const link = "\u001b]8;;https://github.com/o/r/pull/1\u0007#1\u001b]8;;\u0007";
    f.statuses.set("github-pr", `PR ${link}: checks passing`);
    assert.ok(f.render().includes(link));
  } finally {
    f.metadata.dispose();
  }
});

test("metadata participants bypass legacy inline text without changing raw PR links or de-duplication", () => {
  const f = fixture();
  const prKey = "github-pr";
  const link = "\u001b]8;;https://github.com/o/r/pull/1\u0007#1\u001b]8;;\u0007";
  const raw = `PR ${link}: checks passing`;
  f.statuses.clear();
  f.statuses.set(prKey, raw);
  const context = createMockContext({ mode: "tui" });
  const footerData = {
    getGitBranch: () => "feature",
    getExtensionStatuses: () => f.statuses,
    getAvailableProviderCount: () => 0,
    onBranchChange: () => () => undefined,
  };
  const runtime: RuntimeState = {
    ...f.runtime,
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    thinkingLevel: "off",
  };
  const config: StatuslineConfig = { ...DEFAULT_CONFIG, segments: ["branch"] };
  const render = () => {
    const main = renderStatusline(200, context.ctx, footerData, theme, config, runtime, false);
    const extension = renderExtensionStatusline(200, footerData, theme, config, runtime, main, false);
    return { main, extension };
  };
  try {
    assert.ok(render().main.includes(link));
    assert.deepEqual(render().extension, []);
    f.update({ key: prKey, value: raw, activity: "review" });
    assert.equal(render().main.includes(link), false);
    assert.deepEqual(render().extension, ["🔎 ⇕"]);
    f.update({ key: prKey, value: raw, activity: "idle" });
    assert.equal(render().main.includes(link), false);
    assert.deepEqual(render().extension, []);
    f.update({ key: prKey, value: raw, activity: "idle", version: 9 });
    assert.ok(render().main.includes(link));
    assert.deepEqual(render().extension, []);
    f.update({ key: prKey, value: `${raw} `, activity: "idle" });
    assert.ok(render().main.includes(link));
    assert.deepEqual(render().extension, []);
  } finally {
    f.metadata.dispose();
  }
});

test.each([0, 1, 2, 8, 80])("compact output stays bounded at width %s", (width) => {
  const f = fixture();
  try {
    f.update({ activity: "blocked", reason: "storage" });
    const rows = wrapExtensionStatusline(f.render(), width);
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    if (width === 0) assert.deepEqual(rows, []);
    if (width === 80) assert.deepEqual(rows, ["🔌 ! storage"]);
  } finally {
    f.metadata.dispose();
  }
});

test("narrow clipping excludes wide graphemes and closes clipped styles and hyperlinks", () => {
  for (const glyph of ["🔌", "🇯🇵", "👩🏽‍💻", "界"]) {
    for (const value of [
      glyph,
      `\u001b[31m${glyph}\u001b[0m`,
      `\u001b]8;;https://example.test\u0007${glyph}\u001b]8;;\u0007`,
    ]) {
      const rows = wrapExtensionStatusline(`${value} ! storage`, 1);
      assert.ok(
        rows.every((row) => visibleWidth(row) <= 1),
        JSON.stringify(rows),
      );
      assert.ok(
        rows.every((row) => !row.includes(glyph)),
        JSON.stringify(rows),
      );
      // Core carries SGR across wrapped rows; clipping must close it in the complete output.
      const rendered = rows.join("\n");
      if (value.includes("\u001b[31m"))
        assert.ok(rendered.lastIndexOf("\u001b[0m") > rendered.lastIndexOf("\u001b[31m"), JSON.stringify(rows));
      if (value.includes("\u001b]8;;https://example.test"))
        assert.ok(
          rendered.lastIndexOf("\u001b]8;;\u0007") > rendered.lastIndexOf("\u001b]8;;https://example.test"),
          JSON.stringify(rows),
        );
    }
  }
});

test("closed-UI render failures cannot escape the metadata listener", () => {
  let receive: ((payload: unknown) => void) | undefined;
  const sessionManager = {};
  const statuses = new Map([[key, value]]);
  const metadata = subscribeExtensionStatusMetadata(
    {
      on(_channel, handler) {
        receive = handler;
        return () => undefined;
      },
      emit() {},
    },
    sessionManager,
    () => statuses,
    () => {
      throw new Error("UI closed");
    },
  );
  try {
    assert.ok(receive);
    assert.doesNotThrow(() => receive?.({ version: 1, sessionManager, key, value, activity: "review" }));
    assert.equal(metadata.get(key, value)?.activity, "review");
  } finally {
    metadata.dispose();
  }
});

test("subscription and snapshot failures cannot prevent raw footer rendering", () => {
  const f = fixture();
  try {
    const failingEvents = {
      on() {
        throw new Error("subscribe failed");
      },
      emit() {
        throw new Error("request failed");
      },
    };
    const failed = subscribeExtensionStatusMetadata(failingEvents, f.sessionManager, () => f.statuses, f.requestRender);
    assert.equal(failed.get(key, value), undefined);
    failed.dispose();
    const live = subscribeExtensionStatusMetadata(
      { on: f.mock.eventBus.on, emit: failingEvents.emit },
      f.sessionManager,
      () => f.statuses,
      f.requestRender,
    );
    f.update({ activity: "working" });
    assert.equal(live.get(key, value)?.activity, "working");
    live.dispose();
    f.update({ activity: "idle" });
    assert.equal(live.get(key, value), undefined);
  } finally {
    f.metadata.dispose();
  }
});
