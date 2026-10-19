import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  Harness,
  hook,
  type JsonObject,
  MemoryStorage,
  type TaskId,
  type ToolDiagnostic,
  ToolResultEntry,
  ToolTask,
  wrapTool,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurablePlanMode, type DurablePlanCapability, type DurablePlanView } from "../src/durable.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RetainedStorage extends MemoryStorage {
  override async close() {}
}

const identity = (view: DurablePlanView) => ({ workflowId: view.workflowId, revision: view.revision });
const questions = {
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which scope?",
      options: [
        { label: "Small", description: "Limit changes." },
        { label: "Large", description: "Include more changes." },
      ],
    },
  ],
};

const orchestrator = defineTool({
  name: "orchestrator",
  description: "Call one synthetic capability and preserve its error result",
  parameters: Type.Object({ name: Type.String(), hold: Type.Optional(Type.Boolean()) }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const input: JsonObject =
      args.name === "plan_mode_question"
        ? questions
        : args.name === "plan_mode_complete"
          ? { plan: "# Not an activated Plan" }
          : args.hold === undefined
            ? {}
            : { hold: args.hold };
    const result = await api.executeTool(args.name, input, ctx, { key: "child" });
    return { isError: result.isError, diagnostics: result.diagnostics };
  },
});
const caller = defineExtension({ name: "test.caller", tools: [orchestrator] });

async function openFixture(
  extensions: readonly Extension[],
  capabilities: readonly DurablePlanCapability[] = [],
  storage = new RetainedStorage(),
  legacyRawHost = false,
) {
  const raw = createRegistry();
  const results: Array<{ name: string; taskId: TaskId; isError: boolean; diagnostics: readonly ToolDiagnostic[] }> = [];
  const observer = defineExtension({
    name: "test.observer",
    hooks: [
      hook(ToolTask, {
        afterTool: (call, result, api) => {
          results.push({
            name: call.name,
            taskId: api.taskId,
            isError: result.isError === true,
            diagnostics: result.diagnostics ?? [],
          });
        },
      }),
    ],
  });
  for (const extension of [...extensions, caller, observer]) raw.install(extension);
  const integration = createDurablePlanMode({
    registry: raw,
    registryVersion: "deselection-v1",
    capabilities,
  });
  raw.install(integration.extension);
  const sealed = raw.snapshot();
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry: legacyRawHost ? raw : integration.registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  let controller: ReturnType<typeof integration.createController> | undefined;
  try {
    controller = integration.createController(harness);
    const bound = controller;
    const root = await harness.root(context, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });
    const start = () =>
      bound.start(
        root,
        { operationId: "start", workflowId: "workflow", expected: { workflowId: null, revision: 0 } },
        context,
      );
    const discard = async () =>
      bound.discard(root, { operationId: "discard", expected: identity(await bound.inspect(root, context)) }, context);
    const settleDiscard = async (view: DurablePlanView) => {
      const receipt = required(view.receipts.find((item) => item.operationId === "discard"));
      await harness.waitForTask(required(receipt.taskId), context);
      await root.waitForIdle(context);
      const settled = await bound.inspect(root, context);
      expect(settled).toMatchObject({ phase: "inactive" });
      expect(settled.closing).toBeUndefined();
      expect(settled.delivery).toBeUndefined();
      expect(settled.receipts.find((item) => item.operationId === "discard")?.status).toBe("done");
      return settled;
    };
    const deselect = async () => {
      await root.configure({ extensions: { remove: [integration.extension] } }, context);
      expect(raw.snapshot()).toBe(sealed);
      expect((await root.agent(context)).extensions.some((item) => item.name === integration.extension.name)).toBe(
        false,
      );
    };
    let calls = 0;
    const call = async (name: string, nested = false, input: JsonObject = {}) => {
      const id = `call-${name}-${++calls}`;
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(nested ? "orchestrator" : name, nested ? { name, ...input } : input, { id }),
          {
            stopReason: "toolUse",
          },
        ),
        fauxAssistantMessage("Synthetic run finished"),
      ]);
      const submission = await root.submit({ type: "input", content: id }, context);
      expect((await submission.wait(context)).status).toBe("done");
      await root.waitForIdle(context);
      const entries = (await root.context(context)).entries.filter((entry) => ToolResultEntry.is(entry));
      const message = entries
        .flatMap((entry) => entry.model ?? [])
        .find((item) => item.role === "toolResult" && item.toolCallId === id);
      if (message?.role !== "toolResult") throw new Error("Missing settled tool result");
      return message;
    };
    return {
      raw,
      integration,
      harness,
      controller: bound,
      root,
      faux,
      results,
      start,
      discard,
      settleDiscard,
      deselect,
      call,
    };
  } catch (error) {
    try {
      await harness.close(context);
    } finally {
      await controller?.dispose(context);
    }
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof openFixture>>;
async function closeFixture(fixture: Fixture | undefined) {
  if (!fixture) return;
  try {
    await fixture.harness.close(context);
  } finally {
    await fixture.controller.dispose(context);
  }
}

function counter(name: string, effect: () => void, deferred?: true) {
  return defineTool({
    name,
    description: `Synthetic ${name}`,
    parameters: Type.Object({}),
    replay: "safe",
    ...(deferred ? { deferred } : {}),
    execute: async () => {
      effect();
      return {};
    },
  });
}

const normalCases = (["registered", "wrapper", "replacement"] as const).flatMap((implementation) =>
  (["default", "selected", "deferred"] as const).flatMap((exposure) =>
    [false, true].map((nested) => ({ implementation, exposure, nested })),
  ),
);

it.each(normalCases)(
  "admits fresh Normal after settled discard and deselection: $implementation/$exposure, nested=$nested",
  async ({ implementation, exposure, nested }) => {
    const effects: string[] = [];
    const write = counter("write", () => effects.push("original"), exposure === "deferred" ? true : undefined);
    const host = defineExtension({ name: "test.host", tools: [write] });
    const replacement = defineExtension({
      name: "test.replacement",
      tools: [counter("write", () => effects.push("replacement"), exposure === "deferred" ? true : undefined)],
    });
    const wrapper = defineExtension({
      name: "test.wrapper",
      wraps: [
        wrapTool(write, (tool) => ({
          ...tool,
          execute: async () => {
            // Deliberately skip the guarded delegate. The facade must guard this implementation too.
            effects.push("wrapper");
            return {};
          },
        })),
      ],
    });
    const extensions = [
      host,
      ...(implementation === "replacement" ? [replacement] : implementation === "wrapper" ? [wrapper] : []),
    ];
    const f = await openFixture(extensions);
    try {
      expect((await f.start()).phase).toBe("planning");
      await f.settleDiscard(await f.discard());
      await f.deselect();
      if (exposure === "selected")
        await f.root.configure({ tools: [write, orchestrator], modelTools: [nested ? orchestrator : write] }, context);
      if (exposure === "deferred") {
        expect((await f.root.agent(context)).deferred.some((tool) => tool.name === "write")).toBe(true);
        if (!nested) await f.root.configure({ modelTools: { add: [write] } }, context);
      }
      const result = await f.call("write", nested);
      expect(result.isError).toBe(false);
      expect(effects).toEqual([implementation === "registered" ? "original" : implementation]);
      expect(f.results.filter((item) => item.name === "write")).toMatchObject([{ isError: false }]);
      expect((await f.controller.inspect(f.root, context)).phase).toBe("inactive");
    } finally {
      await closeFixture(f);
    }
  },
);

it.each([false, true])("keeps the never-activated Normal control, nested=%s", async (nested) => {
  let effects = 0;
  const f = await openFixture([defineExtension({ name: "test.host", tools: [counter("write", () => effects++)] })]);
  try {
    expect((await f.controller.inspect(f.root, context)).workflowId).toBeNull();
    await f.deselect();
    expect((await f.call("write", nested)).isError).toBe(false);
    expect(effects).toBe(1);
  } finally {
    await closeFixture(f);
  }
});

it.each([false, true])("never enables Plan helpers in Normal, nested=%s", async (nested) => {
  const f = await openFixture([]);
  try {
    await f.start();
    const closed = await f.settleDiscard(await f.discard());
    for (const [name, input] of [
      ["plan_mode_complete", { plan: "# Unapproved plan" }],
      ["plan_mode_question", questions],
    ] satisfies [string, JsonObject][]) {
      const result = await f.call(name, nested, nested ? {} : input);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(nested ? /not available/ : /inactive|Normal/);
    }
    await f.deselect();
    for (const name of ["plan_mode_complete", "plan_mode_question"]) {
      const result = await f.call(
        name,
        nested,
        name === "plan_mode_complete" ? { plan: "# Still inactive" } : questions,
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/not available/);
    }
    expect(await f.controller.inspect(f.root, context)).toEqual(closed);
  } finally {
    await closeFixture(f);
  }
});

it.each([false, true])("keeps active Plan restrictions after deselection, nested=%s", async (nested) => {
  const effects: string[] = [];
  const tools = ["write", "unreviewed", "inspect"].map((name) => counter(name, () => effects.push(name)));
  const f = await openFixture(
    [defineExtension({ name: "test.host", tools })],
    [
      { name: "inspect", policy: "read-only" },
      { name: "orchestrator", policy: "read-only" },
    ],
  );
  try {
    await f.start();
    await f.deselect();
    const write = await f.call("write", nested);
    expect(write.isError).toBe(true);
    expect(JSON.stringify(write)).toContain("Plan mode cannot execute write");
    const unreviewed = await f.call("unreviewed", nested);
    expect(unreviewed.isError).toBe(true);
    expect(JSON.stringify(unreviewed)).toContain("not a reviewed Plan capability");
    expect(effects).toEqual([]);
    const reviewed = await f.call("inspect", nested);
    // Reviewed reads can remain available; deselection must not grant any mutation permission.
    expect(reviewed.isError).toBe(false);
    expect(effects).toEqual(["inspect"]);
    expect((await f.controller.inspect(f.root, context)).phase).toBe("planning");
  } finally {
    await closeFixture(f);
  }
});

const recoveryCases = [false, true].flatMap((nested) => [
  { nested, admission: "reviewed Plan memo", legacyRawHost: false },
  { nested, admission: "unsupported legacy raw-host missing memo", legacyRawHost: true },
]);

it.each(recoveryCases)(
  "rejects recovered $admission while discard settles, nested=$nested",
  async ({ nested, legacyRawHost }) => {
    const entered = barrier();
    const storage = new RetainedStorage();
    let executions = 0;
    let effects = 0;
    let heldTask: TaskId | undefined;
    const inspect = defineTool({
      name: "inspect",
      description: "Hold a reviewed read until cancellation",
      parameters: Type.Object({ hold: Type.Optional(Type.Boolean()) }),
      replay: "safe",
      execute: async (args, api, ctx) => {
        executions++;
        if (args.hold) {
          heldTask = api.taskId;
          entered.resolve();
          await awaitWithContext(new Promise<never>(() => {}), ctx);
        }
        effects++;
        return {};
      },
    });
    const host = defineExtension({ name: "test.host", tools: [inspect, counter("write", () => effects++)] });
    const capabilities: DurablePlanCapability[] = [
      { name: "inspect", policy: "read-only" },
      { name: "orchestrator", policy: "read-only" },
    ];
    let original: Fixture | undefined;
    let recovered: Fixture | undefined;
    try {
      // The legacy characterization deliberately bypasses the mandatory registry facade and removes
      // admission hooks. This is NOT a supported host configuration. It produces an untrusted old
      // execute intent through public APIs, without editing private checkpoints or authorization memos.
      original = await openFixture([host], capabilities, storage, legacyRawHost);
      await original.start();
      if (legacyRawHost) await original.deselect();
      original.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(nested ? "orchestrator" : "inspect", nested ? { name: "inspect", hold: true } : { hold: true }, {
            id: "old-plan-read",
          }),
          { stopReason: "toolUse" },
        ),
      ]);
      const old = await original.root.submit({ type: "input", content: "Hold the reviewed read" }, context);
      await entered.promise;
      const closing = await original.discard();
      expect(closing).toMatchObject({ phase: "inactive", closing: true });
      expect(closing.delivery?.kind).toBe("discard");
      expect({ executions, effects }).toEqual({ executions: 1, effects: 0 });
      await closeFixture(original);

      recovered = await openFixture([host], capabilities, storage);
      await recovered.deselect();
      expect(await recovered.controller.inspect(recovered.root, context)).toMatchObject({
        phase: "inactive",
        closing: true,
      });
      recovered.faux.setResponses([fauxAssistantMessage("Stale research stopped")]);
      expect((await required(await recovered.harness.submission(old.id, context)).wait(context)).status).toBe("done");
      await recovered.settleDiscard(closing);
      expect({ executions, effects }).toEqual({ executions: 1, effects: 0 });
      expect((await recovered.harness.getTask(required(heldTask), context))?.state).toMatchObject({
        status: "terminal",
        outcome: { status: "failed" },
      });
      const denied = recovered.results.filter((item) => item.isError);
      expect(denied.some((item) => item.taskId === heldTask)).toBe(true);
      const error = legacyRawHost ? "Missing Plan execution authorization" : "Stale Plan execution authorization";
      expect(denied.every((item) => item.diagnostics.some((diagnostic) => diagnostic.message.includes(error)))).toBe(
        true,
      );
      const entries = (await recovered.root.context(context)).entries.filter((entry) => ToolResultEntry.is(entry));
      expect(JSON.stringify(entries)).toContain(error);
      expect((await recovered.call("write", nested)).isError).toBe(false);
      expect({ executions, effects }).toEqual({ executions: 1, effects: 1 });
    } finally {
      try {
        await closeFixture(recovered);
      } finally {
        await closeFixture(original);
      }
    }
  },
);
