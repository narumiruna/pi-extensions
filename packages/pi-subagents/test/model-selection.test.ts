import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
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
    properties: Record<string, { type: string; minLength?: number; enum?: string[] }>;
  };
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: unknown,
  ): Promise<{ details: { jobId: string; state: string } }>;
}

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
    assert.equal(schema.enum, undefined);
    for (const value of ["", null, 1, {}, []]) {
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

test("a provider-only override never chooses that provider's other model", async () => {
  const { invoke, requests, session } = await setup({
    models: [parent, { provider: "other-provider", id: "different-default" }],
  });
  await assert.rejects(() => invoke({ provider: "other-provider" }), /other-provider\/parent-model.*not registered/i);
  assert.deepEqual(requests, []);
  assert.deepEqual(session.runtime.inspectJobs().jobs, []);
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
])("rejects non-exact catalog selections %j", async (overrides) => {
  const { invoke, requests } = await setup();
  await assert.rejects(() => invoke(overrides), /not registered/i);
  assert.deepEqual(requests, []);
});

test("strict catalog validation also rejects inherited unlisted custom IDs", async () => {
  const { invoke, requests } = await setup({ model: { ...parent, id: "unlisted-model" } });
  await assert.rejects(() => invoke(), /unlisted-model.*not registered/i);
  assert.deepEqual(requests, []);
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
  const context = createMockContext({
    model: Object.hasOwn(options, "model") ? options.model : parent,
    thinkingLevel: "high",
    isProjectTrusted: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
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
