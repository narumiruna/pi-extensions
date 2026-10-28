import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { assertChildBootstrapCapacity, serializeChildBootstrap } from "../src/broker-credentials.js";
import { buildPiArgs } from "../src/process.js";
import * as resources from "../src/resource-attachments.js";
import { registerSubagentTools } from "../src/tools.js";
import type { ChildRequest } from "../src/types.js";

interface Pair {
  provider: string;
  id: string;
}

interface SpawnTool {
  parameters: TSchema & {
    additionalProperties?: boolean;
    properties: Record<string, { type: string; minLength?: number; maxLength?: number; enum?: string[] }>;
  };
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: unknown,
  ): Promise<{ details: { jobId: string; state: string } }>;
}

const MAX_BOOTSTRAP_BYTES = 16 * 1024;
const parent = { provider: "fixture-provider", id: "parent-model" };
const catalog: Pair[] = [
  parent,
  { provider: "other-provider", id: "parent-model" },
  { provider: "fixture-provider", id: "model-v2" },
  { provider: "other-provider", id: "vendor/model:high" },
];
const sessions: ReturnType<typeof registerSubagentTools>[] = [];

beforeEach(() => {
  vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("spawn schema adds optional literal IDs without a dynamic model enum", async () => {
  const { spawn } = await setup();
  assert.equal(Check(spawn.parameters, { task: "inherit" }), true);
  assert.equal(Check(spawn.parameters, { task: "override", provider: parent.provider, model: parent.id }), true);
  assert.equal(spawn.parameters.additionalProperties, false);
  for (const field of ["provider", "model"]) {
    const schema = spawn.parameters.properties[field];
    assert.equal(schema.type, "string");
    assert.equal(schema.minLength, 1);
    assert.equal(schema.maxLength, MAX_BOOTSTRAP_BYTES);
    assert.equal(schema.enum, undefined);
    assert.equal(Check(spawn.parameters, { task: "boundary", [field]: "m".repeat(MAX_BOOTSTRAP_BYTES) }), true);
    for (const value of ["", null, 1, {}, [], "m".repeat(MAX_BOOTSTRAP_BYTES + 1)]) {
      assert.equal(Check(spawn.parameters, { task: "invalid", [field]: value }), false);
    }
  }
});

test.each([
  [{}, parent.provider, parent.id],
  [{ provider: "other-provider" }, "other-provider", parent.id],
  [{ model: "model-v2" }, parent.provider, "model-v2"],
  [{ provider: "other-provider", model: "vendor/model:high" }, "other-provider", "vendor/model:high"],
] as const)("resolves independent spawn defaults for %j", async (overrides, provider, model) => {
  const { invoke, requests, session } = await setup();
  const result = await invoke(overrides);
  assert.equal(result.details.state, "queued");
  await session.runtime.wait(result.details.jobId, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.provider, provider);
  assert.equal(requests[0]?.model, model);
  assert.equal(requests[0]?.thinkingLevel, "high");
});

test.each(["plain", "界", 'quoted"tool'])(
  "admission preserves the exact bootstrap byte limit for %s",
  async (toolName) => {
    const { invoke, requests, session } = await setup();
    const expectedTools = ["read", "subagent_send", "subagent_wait", toolName];
    const selection = { provider: parent.provider, model: "", thinkingLevel: "high" as const };
    const overhead = Buffer.byteLength(
      serializeChildBootstrap({
        communication: { host: "127.0.0.1", port: 65_535, token: "f".repeat(64) },
        expectedTools,
        selection,
      }),
    );
    const model = "m".repeat(MAX_BOOTSTRAP_BYTES - overhead);
    const parameters = {
      model,
      tools: ["read", "read"],
      extensions: [{ path: "packages/pi-subagents/src/index.ts", tools: [toolName, toolName] }],
    };
    const admitted = await invoke(parameters);
    await session.runtime.wait(admitted.details.jobId, undefined);
    assert.equal(requests.length, 1);
    const child = requests[0];
    assert.ok(child);
    assert.equal(child.model, model);
    const args = buildPiArgs(child);
    assert.equal(args[args.indexOf("--tools") + 1], expectedTools.join(","));
    assert.doesNotThrow(() => assertChildBootstrapCapacity(expectedTools, { ...selection, model }));
    await assert.rejects(() => invoke({ ...parameters, model: `${model}m` }), /child bootstrap size limit/i);
    assert.equal(requests.length, 1);
  },
);

for (const field of ["provider", "model"] as const) {
  for (const source of ["explicit", "inherited"] as const) {
    test.each([
      ["ASCII", () => "m".repeat(MAX_BOOTSTRAP_BYTES + 1)],
      ["large ASCII", () => "m".repeat(4 * 1024 * 1024)],
      ["multibyte UTF-8", () => "界".repeat(Math.floor(MAX_BOOTSTRAP_BYTES / 3) + 1)],
      ["astral UTF-8", () => "😀".repeat(MAX_BOOTSTRAP_BYTES / 4 + 1)],
    ] as const)(`bounds oversized ${source} ${field} IDs before character scans (%s)`, async (_label, createValue) => {
      const value = createValue();
      assert.ok(Buffer.byteLength(value, "utf8") > MAX_BOOTSTRAP_BYTES);
      const inherited = field === "provider" ? { ...parent, provider: value } : { ...parent, id: value };
      const { invoke, requests, session } = await setup({ model: source === "inherited" ? inherited : parent });
      const scans = { trim: 0, iteration: 0 };
      const trim = String.prototype.trim;
      const iterate = String.prototype[Symbol.iterator];
      vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
        if (this.valueOf() === value) scans.trim++;
        return trim.call(this);
      });
      vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (this: string) {
        if (this.valueOf() === value) scans.iteration++;
        return iterate.call(this);
      });
      await assert.rejects(
        () => invoke(source === "explicit" ? { [field]: value } : {}),
        /child bootstrap size limit/i,
      );
      assert.deepEqual(scans, { trim: 0, iteration: 0 });
      assert.deepEqual(requests, []);
      assert.deepEqual(session.runtime.inspectJobs().jobs, []);
    });
  }

  test.each([
    ["ASCII", "m"],
    ["multibyte UTF-8", "界"],
    ["astral UTF-8", "😀"],
    ["JSON escaping", '"\\'],
  ] as const)(`preserves the exact combined bootstrap byte limit for ${field} (%s)`, async (_label, chunk) => {
    const { invoke, requests, session } = await setup();
    const expectedTools = ["subagent_send", "subagent_wait"];
    const selection = { provider: parent.provider, model: parent.id, thinkingLevel: "high" as const, [field]: "" };
    const bootstrap = (id: string) =>
      serializeChildBootstrap({
        communication: { host: "127.0.0.1", port: 65_535, token: "f".repeat(64) },
        expectedTools,
        selection: { ...selection, [field]: id },
      });
    const availableBytes = MAX_BOOTSTRAP_BYTES - Buffer.byteLength(bootstrap(""), "utf8");
    const chunkBytes = Buffer.byteLength(JSON.stringify(chunk), "utf8") - 2;
    const value = chunk.repeat(Math.floor(availableBytes / chunkBytes)) + "m".repeat(availableBytes % chunkBytes);
    assert.equal(Buffer.byteLength(bootstrap(value), "utf8"), MAX_BOOTSTRAP_BYTES);
    const admitted = await invoke({ tools: [], [field]: value });
    await session.runtime.wait(admitted.details.jobId, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.[field], value);
    await assert.rejects(() => invoke({ tools: [], [field]: `${value}m` }), /child bootstrap size limit/i);
    assert.equal(requests.length, 1);
  });
}

test("a provider-only override never chooses that provider's other model", async () => {
  const { invoke, requests, session } = await setup({
    models: [parent, { provider: "other-provider", id: "different-default" }],
  });
  const result = await invoke({ provider: "other-provider" });
  await session.runtime.wait(result.details.jobId, undefined);
  assert.equal(requests[0]?.provider, "other-provider");
  assert.equal(requests[0]?.model, parent.id);
});

test("an explicit pair works without a selected parent model", async () => {
  const { invoke, requests } = await setup({ model: undefined });
  await invoke({ provider: parent.provider, model: parent.id });
  assert.equal(requests[0]?.provider, parent.provider);
  assert.equal(requests[0]?.model, parent.id);
});

test.each([{}, { provider: parent.provider }, { model: parent.id }])(
  "an omitted field requires a selected parent for %j",
  async (overrides) => {
    const { invoke, requests } = await setup({ model: undefined });
    await assert.rejects(() => invoke(overrides), /no main-agent model is selected/i);
    assert.deepEqual(requests, []);
  },
);

test.each(
  [
    "",
    " ",
    "\t\n",
    null,
    1,
    {},
    [],
    "bad\0id",
    "bad\nid",
    "bad\tid",
    "bad\u001bid",
    "bad\u007fid",
    "bad\u0085id",
    "bad\u202eid",
  ].map((value) => [value]),
)("rejects invalid direct-call IDs %j rather than inheriting", async (value) => {
  const { invoke, requests } = await setup();
  for (const field of ["provider", "model"]) {
    await assert.rejects(() => invoke({ [field]: value }), new RegExp(`Subagent ${field}.*exact ID`, "i"));
  }
  assert.deepEqual(requests, []);
});

test.each([
  { provider: "Fixture-provider" },
  { provider: " fixture-provider" },
  { provider: "missing-provider" },
  { model: "PARENT-MODEL" },
  { model: "parent" },
  { model: "parent-model:high" },
  { model: "fixture-provider/parent-model" },
  { model: "parent-model " },
  { model: "unlisted-model" },
])("leaves literal selection %j for the child to validate", async (overrides) => {
  const { invoke, requests, session, find, getAvailableOfType } = await setup({ models: [] });
  const result = await invoke(overrides);
  assert.equal(result.details.state, "queued");
  await session.runtime.wait(result.details.jobId, undefined);
  assert.equal(requests[0]?.provider, overrides.provider ?? parent.provider);
  assert.equal(requests[0]?.model, overrides.model ?? parent.id);
  assert.equal(find.mock.calls.length, 0);
  assert.equal(getAvailableOfType.mock.calls.length, 0);
});

test("leaves inherited unlisted custom IDs for the child to validate", async () => {
  const { invoke, requests, session, find } = await setup({ model: { ...parent, id: "unlisted-model" } });
  const result = await invoke();
  await session.runtime.wait(result.details.jobId, undefined);
  assert.equal(requests[0]?.model, "unlisted-model");
  assert.equal(find.mock.calls.length, 0);
});

test("explicit trusted attachments can register a pair absent from the parent catalog", async () => {
  const { invoke, requests } = await setup({ models: [] });
  await invoke({
    provider: "attached-provider",
    model: "attached/model:high",
    extensions: [{ path: "packages/pi-subagents/src/index.ts", tools: [] }],
  });
  assert.equal(requests[0]?.provider, "attached-provider");
  assert.equal(requests[0]?.model, "attached/model:high");
  assert.equal(requests[0]?.extensions.length, 1);
});

test.each(["runtime", "parent-extension"] as const)(
  "checks the overridden provider rather than the parent's %s restriction",
  async (restriction) => {
    const { invoke, requests } = await setup({ restriction });
    await invoke({ provider: "other-provider" });
    assert.equal(requests[0]?.provider, "other-provider");
  },
);

test.each(["runtime", "parent-extension"] as const)("rejects a selected %s provider", async (restriction) => {
  const { invoke, requests } = await setup({ restriction });
  await assert.rejects(
    () => invoke(),
    restriction === "runtime" ? /process-local runtime API key/i : /children disable parent extensions/i,
  );
  assert.deepEqual(requests, []);
});

test("an attachment does not permit a selected process-local runtime key", async () => {
  const { invoke, requests } = await setup({ restriction: "runtime" });
  await assert.rejects(
    () => invoke({ extensions: [{ path: "packages/pi-subagents/src/index.ts", tools: [] }] }),
    /process-local runtime API key/i,
  );
  assert.deepEqual(requests, []);
});

test("reads one effective model pair after asynchronous preflight and fixes it at admission", async () => {
  const entered = deferred();
  const release = deferred();
  const resolve = resources.resolveResourceAttachments;
  vi.spyOn(resources, "resolveResourceAttachments").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return resolve(...args);
  });
  const { invoke, context, requests } = await setup();
  const admission = invoke();
  await entered.promise;
  const ctx = context.ctx as ExtensionContext;
  Object.defineProperty(ctx, "model", { configurable: true, writable: true, value: catalog[1] });
  release.resolve();
  await admission;
  Object.defineProperty(ctx, "model", { configurable: true, writable: true, value: parent });
  assert.equal(requests[0]?.provider, "other-provider");
  assert.equal(requests[0]?.model, parent.id);
  await invoke();
  assert.equal(requests[1]?.provider, parent.provider);
});

test.each(["cancel", "shutdown", "cwd", "trust"] as const)(
  "rejects %s changes during preflight without admitting a job",
  async (change) => {
    const entered = deferred();
    const release = deferred();
    const resolve = resources.resolveResourceAttachments;
    vi.spyOn(resources, "resolveResourceAttachments").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return resolve(...args);
    });
    const { invoke, context, requests, session } = await setup();
    const controller = new AbortController();
    const admission = invoke({}, controller.signal);
    const rejected = assert.rejects(admission);
    await entered.promise;
    const ctx = context.ctx as ExtensionContext;
    if (change === "cancel") controller.abort();
    if (change === "shutdown") await session.runtime.shutdown();
    if (change === "cwd") ctx.cwd = "/changed-workspace";
    if (change === "trust") ctx.isProjectTrusted = () => false;
    release.resolve();
    await rejected;
    assert.deepEqual(requests, []);
  },
);

async function setup(options: { model?: Pair; models?: Pair[]; restriction?: "runtime" | "parent-extension" } = {}) {
  const mock = createMockPi({ thinkingLevel: "high" });
  const models = options.models ?? catalog;
  const find = vi.fn((provider: string, id: string) =>
    models.find((model) => model.provider === provider && model.id === id),
  );
  const getAvailableOfType = vi.fn(() => {
    throw new Error("The parent must not check child model availability");
  });
  const context = createMockContext({
    model: Object.hasOwn(options, "model") ? options.model : parent,
    thinkingLevel: "high",
    isProjectTrusted: () => true,
    modelRegistry: {
      find,
      getAvailableOfType,
      getProviderAuthStatus: (provider: string) => ({
        configured: true,
        source: options.restriction === "runtime" && provider === parent.provider ? "runtime" : "environment",
      }),
      getRegisteredProviderIds: () => (options.restriction === "parent-extension" ? [parent.provider] : []),
    },
  });
  const requests: ChildRequest[] = [];
  const session = registerSubagentTools(mock.pi, {
    runChild: async (request) => {
      requests.push(request);
      return { state: "completed", result: "done", limitations: [], truncated: false };
    },
  });
  sessions.push(session);
  await session.startSession();
  const spawn = mock.tools.find((tool) => tool.name === "subagent_spawn") as unknown as SpawnTool;
  assert.ok(spawn);
  return {
    context,
    mock,
    session,
    spawn,
    requests,
    find,
    getAvailableOfType,
    invoke: (overrides: Record<string, unknown> = {}, signal?: AbortSignal) =>
      spawn.execute("spawn", { task: "Check model selection", ...overrides }, signal, undefined, context.ctx),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
