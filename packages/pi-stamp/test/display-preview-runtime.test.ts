import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterAll, beforeAll, onTestFinished, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { METADATA_PRESETS, type StampMetadataPreset } from "../src/metadata-settings.js";
import type { StampSettingsPatch } from "../src/settings.js";

const BASE = Date.UTC(2026, 9, 30, 11, 22, 33);
const directory = mkdtempSync(join(tmpdir(), "pi-stamp-display-runtime-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let extension: typeof import("../src/stamp.js");
let settingsModule: typeof import("../src/settings.js");
let sequence = 0;

beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  extension = await import("../src/stamp.js");
  settingsModule = await import("../src/settings.js");
  initTheme("dark", false);
});

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
});

const RECORDED = {
  version: 5,
  role: "assistant",
  timestamp: BASE,
  completedAt: BASE + 3_200,
  thinkingLevel: "high",
  metadata: {
    api: "recorded-api",
    provider: "recorded-provider",
    model: "recorded-model",
    responseModel: "recorded-response",
    responseId: "recorded-sensitive-id",
    stopReason: "length",
    usage: { input: 200, output: 80, totalTokens: 280, estimatedCost: 0.027 },
    diagnosticCount: 1,
    diagnostics: [{ type: "retry", errorName: "HTTPError", errorCode: "429" }],
  },
} as const;

async function harness(overrides: StampSettingsPatch = {}, recordedStamp: unknown = RECORDED) {
  const path = join(directory, `${++sequence}.json`);
  writeFileSync(path, JSON.stringify({ timeZone: "UTC", ...overrides, futureField: { keep: true } }), {
    mode: 0o600,
  });
  const runtime = settingsModule.createStampSettingsRuntime({ path });
  const mock = createMockPi();
  const tui = createTuiHarness({ width: 160, rows: 35 });
  const branch = [
    {
      type: "message",
      id: "original-response",
      message: {
        role: "assistant",
        timestamp: BASE,
        content: [{ type: "text", text: "Response content is not a metadata preview." }],
        api: "actual-api",
        provider: "actual-provider",
        model: "actual-model",
        responseModel: "actual-response",
        thinkingLevel: "max",
        stopReason: "length",
        usage: {
          input: 700,
          output: 90,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 790,
          cost: { input: 0.01, output: 0.009, cacheRead: 0, cacheWrite: 0, total: 0.019 },
        },
      },
    },
    { id: "original-stamp", type: "custom", customType: extension.STAMP_ENTRY_TYPE, data: recordedStamp },
  ];
  let activeBranch: readonly unknown[] = branch;
  let leaf = "original-stamp";
  const getBranch = vi.fn(() => activeBranch);
  const getLeafId = vi.fn(() => leaf);
  const context = createMockContext({
    mode: "tui",
    custom: tui.custom,
    thinkingLevel: "high",
    sessionManager: { getLeafId, getBranch, getSessionId: () => "preview-session" },
  });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, context.ctx);
  };
  extension.default(mock.pi, { settingsRuntime: runtime, now: () => BASE + 3_200 });
  await emit("session_start", { reason: "startup" });
  const renderer = mock.entryRenderers.get(extension.STAMP_ENTRY_TYPE);
  const command = mock.commands.get("stamp");
  assert.ok(renderer && command);
  let running: Promise<unknown> | undefined;
  onTestFinished(async () => {
    await emit("session_shutdown", { reason: "quit" });
    tui.dispose();
    await running;
  });
  const mount = (data: unknown = recordedStamp, expanded = false) => {
    const component = renderer(
      { id: "original-stamp", data },
      { expanded },
      { fg: (_role: string, text: string) => text },
    ) as Component | undefined;
    assert.ok(component);
    return () => component.render(240).map((line) => stripVTControlCharacters(line).trim());
  };
  const open = async () => {
    running = Promise.resolve(command.handler("", context.ctx));
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    return { closed: running };
  };
  const choose = (preset: StampMetadataPreset) => {
    const label = `${preset[0]?.toUpperCase()}${preset.slice(1)}`;
    for (let index = 0; index < 7; index += 1) {
      if (tui.render().some((line) => stripVTControlCharacters(line).startsWith(`→ ${label}`))) return;
      tui.press("tui.select.down");
    }
    assert.fail(`Preset ${label} was not reachable`);
  };
  return {
    runtime,
    mock,
    tui,
    context,
    path,
    emit,
    mount,
    open,
    choose,
    getBranch,
    getLeafId,
    branch,
    setBranch(entries: readonly unknown[], nextLeaf: string) {
      activeBranch = entries;
      leaf = nextLeaf;
    },
  };
}

function reply(captureEnabled: boolean) {
  const field = (value: string) => {
    assert.equal(captureEnabled, true, "A display preview must not enable metadata capture");
    return value;
  };
  return {
    role: "assistant" as const,
    timestamp: BASE,
    content: [{ type: "text" as const, text: "response" }],
    get api() {
      return field("live-api");
    },
    get provider() {
      return field("live-provider");
    },
    get model() {
      return field("live-model");
    },
    get responseId() {
      return field("live-sensitive-id");
    },
    get diagnostics() {
      assert.equal(captureEnabled, true, "A display preview must not enable diagnostics capture");
      return [{ type: "retry", error: { name: "HTTPError", code: 429, message: "private message" } }];
    },
    stopReason: "stop" as const,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.009 } },
  };
}

for (const captureEnabled of [false, true]) {
  test(`display preview does not ${captureEnabled ? "disable" : "enable"} canonical capture or persistence`, async () => {
    const h = await harness({
      ...METADATA_PRESETS[captureEnabled ? "detailed" : "none"],
      showResponseId: captureEnabled,
      showDiagnostics: captureEnabled,
    });
    const render = h.mount(undefined, true);
    const before = [...render()];
    const state = h.runtime.get();
    const file = readFileSync(h.path, "utf8");
    const update = vi.spyOn(h.runtime, "update");
    const recorded = JSON.stringify(RECORDED);
    const branch = JSON.stringify(h.branch);
    h.getBranch.mockClear();
    const menu = await h.open();
    h.choose(captureEnabled ? "none" : "detailed");
    assert.doesNotMatch(
      h.tui.render().join("\n"),
      /(?:^|\n)Preview(?: ·|\n)|metadata is hidden|recorded-provider|actual-provider|live-sensitive-id|thinking max/u,
    );
    assert.equal(h.getBranch.mock.calls.length, 0, "A picker must not inspect responses for saved metadata");
    const preview = [...render()];
    assert.notDeepEqual(preview, before);
    assert.equal(
      preview.some((line) => line.includes("recorded-provider")),
      !captureEnabled,
    );
    assert.equal(
      preview.some((line) => line.includes("recorded-sensitive-id")),
      false,
    );
    assert.equal(h.mock.entries.length, 0);
    assert.deepEqual(h.runtime.get(), state);
    assert.equal(readFileSync(h.path, "utf8"), file);
    assert.equal(update.mock.calls.length, 0);

    const message = reply(captureEnabled);
    await h.emit("turn_start", { turnIndex: 0, timestamp: BASE });
    await h.emit("message_start", { message });
    await h.emit("message_end", { message });
    await h.emit("turn_end", { turnIndex: 0, message, toolResults: [] });
    const stamp = h.mock.entries.at(-1)?.data;
    assert.ok(extension.isMessageStampData(stamp));
    assert.equal(stamp.version, captureEnabled ? 5 : 3);
    if (stamp.version === 5) {
      assert.equal(stamp.thinkingLevel, "high");
      assert.equal(stamp.metadata.responseId, "live-sensitive-id");
      assert.equal(stamp.metadata.diagnosticCount, 1);
    }
    assert.equal(JSON.stringify(stamp).includes("private message"), false);
    h.tui.press("ctrl+c");
    await menu.closed;
    assert.deepEqual(render(), before);
    assert.deepEqual(h.runtime.get(), state);
    assert.equal(readFileSync(h.path, "utf8"), file);
    assert.equal(JSON.stringify(RECORDED), recorded);
    assert.equal(JSON.stringify(h.branch), branch);
    assert.deepEqual(h.mock.setModels, []);
    assert.deepEqual(h.mock.thinkingLevels, []);
    assert.deepEqual(h.mock.sentMessages, []);
    assert.deepEqual(h.mock.sentUserMessages, []);
    assert.equal(update.mock.calls.length, 0);
  });
}

test.each(["back", "hard-cancel", "dispose", "replacement", "shutdown"] as const)(
  "%s clears the real command's display override without a saved-settings rollback",
  async (exit) => {
    const h = await harness(METADATA_PRESETS.none);
    const render = h.mount();
    const before = [...render()];
    const file = readFileSync(h.path, "utf8");
    const state = h.runtime.get();
    const menu = await h.open();
    h.choose("detailed");
    assert.match(render().join("\n"), /recorded-provider/u);
    if (exit === "back") {
      h.tui.press("tui.select.cancel");
      await h.tui.waitForOpen();
      assert.deepEqual(render(), before);
      h.tui.press("ctrl+c");
    } else if (exit === "hard-cancel") h.tui.press("ctrl+c");
    else if (exit === "dispose") h.tui.dispose();
    else {
      const boundary = h.emit(exit === "replacement" ? "session_start" : "session_shutdown", { reason: "switch" });
      assert.deepEqual(render(), before, "Session-boundary cleanup must be synchronous");
      await boundary;
    }
    await menu.closed;
    assert.deepEqual(render(), before);
    assert.deepEqual(h.runtime.get().settings, state.settings);
    assert.equal(readFileSync(h.path, "utf8"), file);
    assert.deepEqual(h.mock.entries, []);
  },
);

test.each(["saved", "timestamp-only"] as const)(
  "confirmation saves once and retains %s Stamp metadata after preview cleanup",
  async (kind) => {
    const h = await harness(
      METADATA_PRESETS.none,
      kind === "saved" ? RECORDED : { version: 2, role: "assistant", timestamp: BASE },
    );
    const render = h.mount();
    const update = vi.spyOn(h.runtime, "update");
    const menu = await h.open();
    h.choose("usage");
    assert.match(
      render().join("\n"),
      kind === "saved" ? /tokens in 200 · out 80 · total 280/u : /tokens in 700 · out 90.*total 790/u,
    );
    assert.equal(update.mock.calls.length, 0);
    h.tui.press("tui.select.confirm");
    await h.tui.waitForOpen();
    if (h.tui.render().some((line) => stripVTControlCharacters(line).includes("Saving Stamp preset"))) {
      await h.tui.resultPromise;
      await h.tui.waitForOpen();
    }
    const saved = [...render()];
    h.tui.press("tui.select.cancel");
    await h.tui.waitForOpen();
    assert.deepEqual(render(), saved);
    h.tui.press("ctrl+c");
    await menu.closed;
    assert.deepEqual(update.mock.calls, [[METADATA_PRESETS.usage]]);
    const document = JSON.parse(readFileSync(h.path, "utf8"));
    assert.deepEqual(document.futureField, { keep: true });
    for (const [field, value] of Object.entries(METADATA_PRESETS.usage)) assert.equal(document[field], value);
    assert.deepEqual(h.context.notifications, [{ message: "Metadata preset: Usage.", level: "info" }]);
    assert.deepEqual(h.mock.entries, []);
  },
);

test("cancellation drops only the overlay and retains newer canonical fields and nonmetadata preferences", async () => {
  const h = await harness(METADATA_PRESETS.none);
  const render = h.mount();
  const menu = await h.open();
  h.choose("cost");
  await h.runtime.update({ ...METADATA_PRESETS.model, hourCycle: "12h", showSeconds: false });
  const canonical = h.runtime.get();
  const document = readFileSync(h.path, "utf8");
  assert.deepEqual(render(), ["11:22 AM", "est $0.027"]);
  h.tui.press("ctrl+c");
  await menu.closed;
  assert.deepEqual(render(), ["11:22 AM", "recorded-model → recorded-response · thinking high"]);
  assert.deepEqual(h.runtime.get(), canonical);
  assert.equal(readFileSync(h.path, "utf8"), document);
});

test("the original timestamp-only Stamp follows each cursor choice without saving metadata or recovering Thinking", async () => {
  const h = await harness({}, { version: 3, role: "assistant", timestamp: BASE, completedAt: BASE + 3_200 });
  const render = h.mount();
  const before = [...render()];
  const branch = JSON.stringify(h.branch);
  const file = readFileSync(h.path, "utf8");
  const update = vi.spyOn(h.runtime, "update");
  h.getBranch.mockClear();
  const menu = await h.open();
  for (const preset of ["detailed", "model", "usage", "cost", "abnormal", "none", "compact"] as const) {
    h.choose(preset);
    const picker = h.tui.render().join("\n");
    const stamp = render().join("\n");
    assert.doesNotMatch(picker, /(?:^|\n)Preview(?: ·|\n)|No enabled fields|metadata is hidden|actual-model/u);
    assert.doesNotMatch(stamp, /thinking high|thinking max|recorded-model|Response content|debug/u);
    if (preset === "detailed") assert.match(stamp, /api actual-api.*provider actual-provider/u);
    if (preset === "model") assert.match(stamp, /actual-model → actual-response/u);
    if (preset === "usage") assert.match(stamp, /tokens in 700 · out 90.*total 790/u);
    if (preset === "cost") assert.match(stamp, /est \$0\.019/u);
    if (preset === "abnormal") assert.match(stamp, /stop length/u);
    if (preset === "none") assert.deepEqual(render(), before);
    if (preset === "compact") assert.match(stamp, /actual-model → actual-response.*790 tok.*est \$0\.019/u);
    assert.equal(h.runtime.get().settings.showRequestedModel, false, "Display must not enable canonical capture");
  }
  h.tui.press("ctrl+c");
  await menu.closed;
  assert.deepEqual(render(), before);
  assert.equal(h.getBranch.mock.calls.length, 1, "One leaf must use one lazy transcript snapshot");
  assert.equal(JSON.stringify(h.branch), branch);
  assert.equal(readFileSync(h.path, "utf8"), file);
  assert.equal(update.mock.calls.length, 0);
  assert.deepEqual(h.mock.entries, []);
  assert.deepEqual(h.mock.sentMessages, []);
  assert.deepEqual(h.mock.sentUserMessages, []);
});

test("already-mounted fallback follows the active leaf and clears on shutdown without a settings change", async () => {
  const h = await harness(METADATA_PRESETS.model, { version: 2, role: "assistant", timestamp: BASE });
  const render = h.mount();
  const canonical = h.runtime.get();
  assert.match(render().join("\n"), /actual-model → actual-response/u);
  const changed = structuredClone(h.branch);
  const message = changed[0]?.message;
  assert.ok(message);
  message.model = "branch-model";
  h.setBranch(changed, "changed-leaf");
  assert.match(render().join("\n"), /branch-model → actual-response/u);
  assert.doesNotMatch(render().join("\n"), /actual-model/u);
  assert.deepEqual(h.runtime.get(), canonical);
  await h.emit("session_shutdown", { reason: "quit" });
  const reads = h.getBranch.mock.calls.length;
  assert.deepEqual(render(), ["11:22:33"]);
  assert.equal(h.getBranch.mock.calls.length, reads, "Shutdown must detach the old session source");
  await h.emit("session_start", { reason: "switch" });
  assert.match(render().join("\n"), /branch-model → actual-response/u);
  assert.deepEqual(h.runtime.get().settings, canonical.settings);
  assert.deepEqual(h.mock.entries, []);
});
