import { awaitWithContext } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  CompactionTask,
  defineExtension,
  hook,
  LiveDoc,
  SystemEntry,
  ToolTask,
  wrapTool,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { NORMAL_CONTRACT, PLAN_CONTRACT } from "../src/durable-policy.js";
import {
  barrier,
  context,
  defineTool,
  fauxAssistantMessage,
  fauxToolCall,
  fixture,
  Type,
  WorkflowDoc,
} from "./durable-policy-support.js";
import { required } from "./durable-test-values.js";

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

describe("durable production execution policy", () => {
  it("admits normal tools without activation, but never treats helper visibility as activation", async () => {
    let effects = 0;
    const f = await fixture({ tools: [counter("write", () => effects++)], capabilities: [] });
    await f.call("write");
    await f.call("plan_mode_complete", { plan: "not active" });
    expect(effects).toBe(1);
    expect((await f.harness.snapshot(WorkflowDoc, f.root.id, context))?.plan).toBeUndefined();
  });

  it.each([false, true])("gates every direct/nested capability, nested=%s", async (nested) => {
    const effects: string[] = [];
    const tools = ["inspect", "write", "edit", "update_plan", "unreviewed"].map((name) =>
      counter(name, () => effects.push(name), name === "unreviewed" ? true : undefined),
    );
    const orchestrator = defineTool({
      name: "orchestrator",
      description: "Reviewed orchestrator",
      parameters: Type.Object({ name: Type.String() }),
      replay: "safe",
      execute: async (args, api, ctx) => {
        await api.executeTool(args.name, {}, ctx);
        return {};
      },
    });
    const f = await fixture({
      tools: [...tools, orchestrator],
      capabilities: [
        { name: "inspect", policy: "read-only" },
        { name: "orchestrator", policy: "read-only" },
      ],
    });
    await f.activate();
    for (const name of ["inspect", "write", "edit", "update_plan", "unreviewed"]) {
      if (!nested && name === "unreviewed")
        await f.root.configure({ modelTools: { add: [required(tools[4])] } }, context);
      await f.call(nested ? "orchestrator" : name, nested ? { name } : {});
    }
    expect(effects).toEqual(["inspect"]);
  });

  it.each(["bash", "powershell"] as const)("rechecks final %s arguments with the pure shell policy", async (policy) => {
    let effects = 0;
    const tool = defineTool({
      name: "shell",
      description: "Reviewed limited shell",
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => {
        effects++;
        return {};
      },
    });
    const f = await fixture({ tools: [tool], capabilities: [{ name: "shell", policy }] });
    await f.activate();
    await f.call("shell", { command: policy === "bash" ? "git status" : "Get-Content README.md" });
    await f.call("shell", { command: policy === "bash" ? "rm README.md" : "Remove-Item README.md" });
    expect(effects).toBe(1);
  });

  it.each(["ready", "awaiting_answers", "handoff_pending", "inactive", "fork"])(
    "denies %s workflows",
    async (phase) => {
      let effects = 0;
      const f = await fixture({ tools: [counter("inspect", () => effects++)] });
      await f.activate();
      await f.root.commit(async (tx) => {
        const state = await tx.doc(WorkflowDoc, f.root.id);
        if (phase === "fork") state.owner++;
        else if (phase === "inactive") {
          state.phase = "inactive";
          state.closing = true;
        } else state.phase = phase as "ready" | "awaiting_answers" | "handoff_pending";
      }, context);
      await f.call("inspect");
      expect(effects).toBe(0);
    },
  );

  it.each(["revision", "capabilities", "registryVersion", "closing"] as const)(
    "rechecks %s after admission, even when a reviewed wrapper skips its delegate",
    async (change) => {
      let effects = 0;
      let f: Awaited<ReturnType<typeof fixture>>;
      const inspect = counter("inspect", () => effects++);
      const revoke = hook(ToolTask, {
        beforeTool: async (call) => {
          if (call.name !== "inspect") return;
          await f.root.commit(async (tx) => {
            const state = await tx.doc(WorkflowDoc, f.root.id);
            if (change === "revision") state.revision++;
            else if (change === "capabilities") state.capabilities = [];
            else if (change === "registryVersion") state.registryVersion = "unreviewed";
            else state.closing = true;
          }, context);
        },
      });
      f = await fixture({
        tools: [inspect],
        hooks: [revoke],
        extensions: [
          defineExtension({
            name: "bypass",
            wraps: [
              wrapTool(inspect, (tool) => ({
                ...tool,
                execute: async () => {
                  effects++;
                  return {};
                },
              })),
            ],
          }),
        ],
      });
      await f.activate();
      await f.call("inspect");
      expect(effects).toBe(0);
    },
  );

  it("allows fully closed old-version workflows to return to Normal after host restart", async () => {
    let effects = 0;
    const f = await fixture({ tools: [counter("write", () => effects++)], capabilities: [] });
    await f.activate();
    await f.root.commit(async (tx) => {
      const state = await tx.doc(WorkflowDoc, f.root.id);
      state.registryVersion = "previous-review";
      state.capabilities = [{ name: "old-inspect", policy: "read-only" }];
      state.phase = "inactive";
      state.revision++;
    }, context);
    await f.call("write");
    expect(effects).toBe(1);
    await f.activate();
    expect((await f.harness.snapshot(WorkflowDoc, f.root.id, context))?.registryVersion).toBe("reviewed-v1");
  });

  it("removing the policy extension cannot bypass the facade, including bypassing wrappers", async () => {
    let effects = 0;
    const write = counter("write", () => effects++);
    const f = await fixture({
      tools: [write],
      extensions: [
        defineExtension({
          name: "bypass",
          wraps: [
            wrapTool(write, (tool) => ({
              ...tool,
              execute: async () => {
                effects++;
                return {};
              },
            })),
          ],
        }),
      ],
    });
    await f.activate();
    await f.root.configure({ extensions: { remove: [f.extension] } }, context);
    await f.call("write");
    expect(effects).toBe(0);
  });

  it("keeps facade references consistent and provider-visible tool metadata unchanged", async () => {
    const inspect = counter("inspect", () => {}, true);
    const f = await fixture({ tools: [inspect] });
    const snapshot = f.policy.reader.snapshot();
    const extension = required(snapshot.extension("capabilities"));
    expect(snapshot.installed().find((item) => item.name === extension.name)).toBe(extension);
    expect(snapshot.tools().find((item) => item.tool.name === "inspect")).toEqual({
      extension,
      tool: required(extension.tools)[0],
    });
    const { execute: _raw, ...rawFields } = inspect;
    const { execute: _guard, ...guardedFields } = required(required(extension.tools)[0]);
    expect(guardedFields).toEqual(rawFields);
    expect(snapshot.tasks()).toEqual(f.raw.snapshot().tasks());
  });

  it.each(["override", "wrapper", "remove"])(
    "seals the first raw snapshot and rejects %s publication",
    async (change) => {
      const inspect = counter("inspect", () => {});
      const f = await fixture({ tools: [inspect] });
      const snapshot = f.policy.reader.snapshot();
      if (change === "remove") f.raw.uninstall(f.extension);
      else
        f.raw.install(
          defineExtension({
            name: "capabilities",
            tools: [inspect],
            ...(change === "wrapper" ? { wraps: [wrapTool(inspect, (tool) => tool)] } : {}),
          }),
        );
      expect(() => f.policy.reader.snapshot()).toThrow(/restart the host.*registryVersion/);
      await expect(
        required(required(required(snapshot.extension("capabilities")).tools)[0]).execute({}, {} as never, context),
      ).rejects.toThrow(/registry changed/);
    },
  );

  it.each([false, true])(
    "rejects stale recovered direct/nested tasks without rerunning beforeTool, nested=%s",
    async (nested) => {
      const entered = barrier();
      let executions = 0;
      let effects = 0;
      const inspect = defineTool({
        name: "inspect",
        description: "Reviewed inspect",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, _api, ctx) => {
          executions++;
          entered.resolve();
          await awaitWithContext(new Promise<never>(() => {}), ctx);
          effects++;
          return {};
        },
      });
      const orchestrator = defineTool({
        name: "orchestrator",
        description: "Reviewed orchestrator",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, ctx) => ({
          isError: (await api.executeTool("inspect", {}, ctx, { key: "child" })).isError,
        }),
      });
      const f = await fixture({
        tools: [inspect, orchestrator],
        capabilities: [
          { name: "inspect", policy: "read-only" },
          { name: "orchestrator", policy: "read-only" },
        ],
      });
      await f.activate();
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall(nested ? "orchestrator" : "inspect", {}, { id: "recover" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("finished"),
      ]);
      const submission = await f.root.submit({ type: "input", content: "inspect" }, context);
      await entered.promise;
      await f.harness.close(context);
      const reopened = await f.open();
      const root = await reopened.root(context);
      await root.commit(async (tx) => {
        const state = await tx.doc(WorkflowDoc, root.id);
        state.phase = "inactive";
        state.revision++;
      }, context);
      await required(await reopened.submission(submission.id, context)).wait(context);
      expect({ executions, effects }).toEqual({ executions: 1, effects: 0 });
    },
  );

  it.each(["replacement", "wrapper"] as const)(
    "rejects a reviewed-version %s swap before recovered code executes",
    async (change) => {
      const entered = barrier();
      let oldExecutions = 0;
      let unreviewedEffects = 0;
      const inspect = defineTool({
        name: "inspect",
        description: "Original reviewed capability",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, _api, ctx) => {
          oldExecutions++;
          entered.resolve();
          await awaitWithContext(new Promise<never>(() => {}), ctx);
          return {};
        },
      });
      const first = await fixture({ tools: [inspect] });
      await first.activate();
      first.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("inspect", {}, { id: "recover-version" }), { stopReason: "toolUse" }),
      ]);
      const submission = await first.root.submit({ type: "input", content: "inspect" }, context);
      await entered.promise;
      await first.harness.close(context);
      const replacement = counter("inspect", () => unreviewedEffects++);
      const reopened = await fixture({
        storage: first.storage,
        registryVersion: "reviewed-v2",
        tools: [change === "replacement" ? replacement : inspect],
        ...(change === "wrapper"
          ? {
              extensions: [
                defineExtension({
                  name: "replacement-wrapper",
                  wraps: [
                    wrapTool(inspect, (tool) => ({
                      ...tool,
                      execute: async () => {
                        unreviewedEffects++;
                        return {};
                      },
                    })),
                  ],
                }),
              ],
            }
          : {}),
      });
      reopened.faux.setResponses([fauxAssistantMessage("recovery stopped")]);
      const restored = await reopened.harness.submission(submission.id, context);
      if (!restored) throw new Error("Missing recovered submission");
      await restored.wait(context);
      expect({ oldExecutions, unreviewedEffects }).toEqual({ oldExecutions: 1, unreviewedEffects: 0 });
    },
  );

  it("requires placed, exact approved kickoff input before Normal; then promotes inside execution", async () => {
    let effects = 0;
    const f = await fixture({ tools: [counter("write", () => effects++)], capabilities: [] });
    await f.activate();
    await f.root.commit(async (tx) => {
      const state = await tx.doc(WorkflowDoc, f.root.id);
      state.phase = "handoff_pending";
      state.revision = 2;
      state.plan = "EXACT PLAN";
      state.approval = { planRevision: 1, requestId: "approval" };
      state.delivery = {
        kind: "approve",
        operationId: "approve",
        requestId: "approval",
        revision: 2,
        content: "EXACT PLAN",
      };
      state.receipts.push({
        operationId: "approve",
        kind: "approve",
        revision: 2,
        fingerprint: "synthetic",
        status: "pending",
        requestId: "approval",
      });
    }, context);
    await f.call("write");
    expect(effects).toBe(0);
    let normal = false;
    f.faux.setResponses([
      (input) => {
        normal = input.messages.some(
          (message) => message.role === "system" && message.sections?.plan_mode === NORMAL_CONTRACT,
        );
        return fauxAssistantMessage(fauxToolCall("write", {}, { id: "approved" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("implemented"),
    ]);
    await (
      await f.root.submit(
        {
          type: "input",
          requestId: "approval",
          content: "EXACT PLAN",
          entry: { kind: "plan-mode.input", data: { workflowId: "workflow", revision: 2, operationId: "approve" } },
        },
        context,
      )
    ).wait(context);
    const state = await f.harness.snapshot(WorkflowDoc, f.root.id, context);
    expect({
      normal,
      effects,
      phase: state?.phase,
      planRevision: state?.approval?.planRevision,
      delivery: state?.delivery,
    }).toEqual({ normal: true, effects: 1, phase: "implementing", planRevision: 1, delivery: undefined });
  });

  it.each(["content", "missing-marker", "wrong-marker", "extra-marker-field"] as const)(
    "rejects approval requestId collisions with %s",
    async (collision) => {
      let effects = 0;
      const f = await fixture({ tools: [counter("write", () => effects++)], capabilities: [] });
      await f.activate();
      await f.root.commit(async (tx) => {
        const state = await tx.doc(WorkflowDoc, f.root.id);
        state.phase = "handoff_pending";
        state.revision = 2;
        state.plan = "EXACT PLAN";
        state.approval = { planRevision: 1, requestId: "approval" };
        state.delivery = {
          kind: "approve",
          operationId: "approve",
          requestId: "approval",
          revision: 2,
          content: "EXACT PLAN",
        };
        state.receipts.push({
          operationId: "approve",
          kind: "approve",
          revision: 2,
          fingerprint: "fixture",
          status: "pending",
          requestId: "approval",
        });
      }, context);
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", {}, { id: "collision" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("finished"),
      ]);
      await (
        await f.root.submit(
          {
            type: "input",
            requestId: "approval",
            content: collision === "content" ? "NOT THE PLAN" : "EXACT PLAN",
            ...(collision === "missing-marker"
              ? {}
              : {
                  entry: {
                    kind: "plan-mode.input",
                    data: {
                      workflowId: collision === "wrong-marker" ? "other-workflow" : "workflow",
                      revision: 2,
                      operationId: "approve",
                      ...(collision === "extra-marker-field" ? { extra: "unexpected" } : {}),
                    },
                  },
                }),
          },
          context,
        )
      ).wait(context);
      expect(effects).toBe(0);
      expect((await f.harness.snapshot(WorkflowDoc, f.root.id, context))?.phase).toBe("handoff_pending");
    },
  );

  it("a real fork of an implementing workflow inherits neither Normal permission nor approval", async () => {
    let effects = 0;
    const f = await fixture({ tools: [counter("write", () => effects++)], capabilities: [] });
    await f.activate();
    f.faux.setResponses([fauxAssistantMessage("Synthetic kickoff fixture")]);
    const kickoff = await f.root.submit({ type: "input", content: "EXACT PLAN", requestId: "approved" }, context);
    await kickoff.wait(context);
    await f.root.commit(async (tx) => {
      const state = await tx.doc(WorkflowDoc, f.root.id);
      state.phase = "implementing";
      state.revision = 2;
      state.plan = "EXACT PLAN";
      state.approval = { planRevision: 1, requestId: "approved", submissionId: kickoff.id };
    }, context);
    await f.call("write");
    expect(effects).toBe(1);
    const entries = (await f.root.context(context)).entries;
    const last = entries.at(-1);
    if (!last) throw new Error("Missing fork entry");
    const fork = await f.root.fork(last.id, { ownership: { kind: "ownerless" } }, context);
    let plan = false;
    f.faux.setResponses([
      (input) => {
        plan = input.messages.some(
          (message) => message.role === "system" && message.sections?.plan_mode === PLAN_CONTRACT,
        );
        return fauxAssistantMessage(fauxToolCall("write", {}, { id: "fork-write" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("fork finished"),
    ]);
    await (await fork.submit({ type: "input", content: "implement in fork" }, context)).wait(context);
    expect(plan).toBe(true);
    expect(effects).toBe(1);
  });

  it("persists static Plan contracts and one restoration baseline after compaction", async () => {
    const requests: Message[][] = [];
    const f = await fixture({
      hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: "Compacted synthetic history" }) })],
    });
    await f.activate();
    const send = async (text: string) => {
      f.faux.setResponses([
        (input) => {
          requests.push(structuredClone(input.messages));
          return fauxAssistantMessage(text);
        },
      ]);
      await (await f.root.submit({ type: "input", content: text }, context)).wait(context);
    };
    const normalize = (messages: Message[]) => messages.map(({ timestamp: _timestamp, ...message }) => message);
    await send("one");
    await send("two");
    expect(normalize(required(requests[1])).slice(0, required(requests[0]).length)).toEqual(
      normalize(required(requests[0])),
    );
    const compacted = await f.harness.waitForTask(await f.root.compact(undefined, context), context);
    if (compacted.state.outcome.status !== "completed") throw new Error("Compaction failed");
    await required(await f.harness.submission(required(compacted.state.outcome.result.submissionId), context)).wait(
      context,
    );
    await send("three");
    await send("four");
    expect(normalize(required(requests[3])).slice(0, required(requests[2]).length)).toEqual(
      normalize(required(requests[2])),
    );
    expect(
      (await f.root.context(context)).entries.filter(
        (entry) =>
          SystemEntry.is(entry) &&
          entry.model?.some((message) => message.role === "system" && message.sections?.plan_mode === PLAN_CONTRACT),
      ),
    ).toHaveLength(1);
    expect((await f.harness.snapshot(LiveDoc, f.root.id, context))?.run).toBeUndefined();
  });
});
