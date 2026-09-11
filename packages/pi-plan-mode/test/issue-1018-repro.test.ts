import assert from "node:assert/strict";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { filterAvailableSelectedToolNames, snapshotPlanModeSelectedNames } from "../src/tool-selection.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const LATE_TOOL = "late_tool";

async function startPlan(options: {
  configured?: string[];
  activeTools?: string[];
  allTools?: ReturnType<typeof builtinTool>[];
}) {
  const allTools = options.allTools ?? [builtinTool("read")];
  const mock = createMockPi({ activeTools: options.activeTools ?? ["read"], allTools });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: {
        thinkingLevel: "inherit" as const,
        ...(options.configured === undefined ? {} : { defaultPlanTools: [...options.configured] }),
      },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  return { allTools, context, mock };
}

function registerLateTool(fixture: Awaited<ReturnType<typeof startPlan>>, name = LATE_TOOL) {
  fixture.allTools.push(extensionTool(name));
  fixture.mock.rawPi.setActiveTools([...new Set([...fixture.mock.rawPi.getActiveTools(), name])]);
}

async function runBeforeAgentStart(fixture: Awaited<ReturnType<typeof startPlan>>) {
  for (const handler of fixture.mock.events.get("before_agent_start") ?? []) {
    await handler({ prompt: "plan", systemPrompt: "stable" }, fixture.context.ctx);
  }
}

async function runContext(fixture: Awaited<ReturnType<typeof startPlan>>) {
  for (const handler of fixture.mock.events.get("context") ?? []) {
    await handler({ messages: [] }, fixture.context.ctx);
  }
}

async function callTool(fixture: Awaited<ReturnType<typeof startPlan>>, toolName: string) {
  return fixture.mock.events.get("tool_call")?.[0]?.({ toolName, input: {} }, fixture.context.ctx) as
    | { block?: boolean; reason?: string }
    | undefined;
}

test("explicit tool intent is retained until availability is resolved", () => {
  const tools = [builtinTool("read"), builtinTool("write"), extensionTool(LATE_TOOL)] as ToolInfo[];
  const untrustedName = "pending\u001b[31m_tool";
  assert.deepEqual(
    Array.from(
      snapshotPlanModeSelectedNames(tools, {
        defaultPlanTools: [LATE_TOOL, "missing", "write", LATE_TOOL],
      }),
    ),
    [LATE_TOOL, "missing", "write"],
  );
  assert.deepEqual(filterAvailableSelectedToolNames([LATE_TOOL, "missing", "write", LATE_TOOL], tools), [LATE_TOOL]);
  assert.deepEqual(
    Array.from(
      snapshotPlanModeSelectedNames(tools, {
        selectedToolKeys: [`${LATE_TOOL}\u001flegacy-source`, "missing\u001flegacy-source"],
      }),
    ),
    [LATE_TOOL],
  );
  assert.deepEqual(
    Array.from(snapshotPlanModeSelectedNames(tools, {})),
    ["read"],
    "automatic defaults keep only safe built-ins",
  );
  assert.deepEqual(
    Array.from(snapshotPlanModeSelectedNames(tools, { defaultPlanTools: [untrustedName] })),
    [untrustedName],
    "display sanitization must not mutate policy intent",
  );
});

test("configured tools registered before the first Plan context join that workflow policy", async () => {
  for (const timing of ["before-plan-handler", "after-plan-handler"] as const) {
    const fixture = await startPlan({ configured: [LATE_TOOL] });
    if (timing === "before-plan-handler") registerLateTool(fixture);
    await runBeforeAgentStart(fixture);
    if (timing === "after-plan-handler") registerLateTool(fixture);
    await runContext(fixture);

    assert.equal(await callTool(fixture, LATE_TOOL), undefined, timing);
  }
});

test("unconfigured late custom tools remain denied", async () => {
  const fixture = await startPlan({});
  registerLateTool(fixture);
  await runBeforeAgentStart(fixture);
  await runContext(fixture);

  assert.equal((await callTool(fixture, LATE_TOOL))?.block, true);
});

test("automatic defaults reject a late custom override while explicit intent allows it", async () => {
  const automatic = await startPlan({});
  automatic.allTools.splice(0, 1, extensionTool("read"));
  await runBeforeAgentStart(automatic);
  await runContext(automatic);
  assert.equal((await callTool(automatic, "read"))?.block, true);

  const explicit = await startPlan({ configured: ["read"] });
  explicit.allTools.splice(0, 1, extensionTool("read"));
  await runBeforeAgentStart(explicit);
  await runContext(explicit);
  assert.equal(await callTool(explicit, "read"), undefined);
});

test("configured inactive and metadata-free tools remain denied", async () => {
  const inactive = await startPlan({
    configured: [LATE_TOOL],
    allTools: [builtinTool("read"), extensionTool(LATE_TOOL)],
  });
  await runContext(inactive);
  assert.equal((await callTool(inactive, LATE_TOOL))?.block, true);

  const missingMetadata = await startPlan({
    configured: [LATE_TOOL],
    activeTools: ["read", LATE_TOOL],
  });
  await runContext(missingMetadata);
  assert.equal((await callTool(missingMetadata, LATE_TOOL))?.block, true);
});

test("configured Plan-blocked built-ins remain denied", async () => {
  const fixture = await startPlan({
    configured: ["write"],
    activeTools: ["read", "write"],
    allTools: [builtinTool("read"), builtinTool("write")],
  });
  await runContext(fixture);

  const result = await callTool(fixture, "write");
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /mutating tool/u);
});

test("registration after first context waits for the next workflow", async () => {
  const fixture = await startPlan({ configured: [LATE_TOOL] });
  await runContext(fixture);
  registerLateTool(fixture);
  await runContext(fixture);
  assert.equal((await callTool(fixture, LATE_TOOL))?.block, true);

  await fixture.mock.commands.get("plan")?.handler("exit", fixture.context.ctx);
  await fixture.mock.commands.get("plan")?.handler("start", fixture.context.ctx);
  await runContext(fixture);
  assert.equal(await callTool(fixture, LATE_TOOL), undefined);
});

test("a resolved allowlist stays frozen when its active workflow is restored", async () => {
  const fixture = await startPlan({ configured: [LATE_TOOL] });
  await runContext(fixture);
  const resolvedState = fixture.mock.entries.at(-1)?.data as
    | {
        workflowToolPolicy?: {
          allowedNames?: string[];
          resolved?: boolean;
        };
      }
    | undefined;
  assert.equal(resolvedState?.workflowToolPolicy?.resolved, true);
  assert.deepEqual(resolvedState?.workflowToolPolicy?.allowedNames, []);

  registerLateTool(fixture);
  const branch = fixture.mock.entries.map((entry) => ({ type: "custom", ...entry }));
  const replacement = createMockContext({
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getEntry: () => undefined,
    },
  });
  await fixture.mock.events.get("session_start")?.[0]?.({ reason: "resume" }, replacement.ctx);
  await fixture.mock.events.get("context")?.[0]?.({ messages: [] }, replacement.ctx);

  const result = (await fixture.mock.events.get("tool_call")?.[0]?.(
    { toolName: LATE_TOOL, input: {} },
    replacement.ctx,
  )) as { block?: boolean } | undefined;
  assert.equal(result?.block, true);
});

test("restoration revalidates a frozen allowed name after late registration", async () => {
  const fixture = await startPlan({
    configured: [LATE_TOOL],
    activeTools: ["read", LATE_TOOL],
    allTools: [builtinTool("read"), extensionTool(LATE_TOOL)],
  });
  await runContext(fixture);
  const branch = fixture.mock.entries.map((entry) => ({ type: "custom", ...entry }));
  fixture.allTools.splice(1, 1);
  fixture.mock.rawPi.setActiveTools(["read", "plan_mode_question", "plan_mode_complete"]);
  const replacement = createMockContext({
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getEntry: () => undefined,
    },
  });
  await fixture.mock.events.get("session_start")?.[0]?.({ reason: "resume" }, replacement.ctx);
  fixture.allTools.push(extensionTool(LATE_TOOL));
  fixture.mock.rawPi.setActiveTools([...fixture.mock.rawPi.getActiveTools(), LATE_TOOL]);
  await fixture.mock.events.get("context")?.[0]?.({ messages: [] }, replacement.ctx);

  assert.equal(
    await fixture.mock.events.get("tool_call")?.[0]?.({ toolName: LATE_TOOL, input: {} }, replacement.ctx),
    undefined,
  );
});

test("malformed persisted workflow policy fails closed", async () => {
  const stateEntry = {
    type: "custom",
    customType: "plan-mode-state",
    data: {
      enabled: true,
      awaitingAction: false,
      selectedToolNames: [LATE_TOOL],
      workflowToolPolicy: {
        kind: "explicit",
        desiredNames: [LATE_TOOL],
        allowedNames: [LATE_TOOL],
        resolved: "yes",
      },
    },
  };
  const mock = createMockPi({
    activeTools: ["read", LATE_TOOL],
    allTools: [builtinTool("read"), extensionTool(LATE_TOOL)],
  });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({
    sessionManager: {
      getBranch: () => [stateEntry],
      getEntries: () => [stateEntry],
      getEntry: () => undefined,
    },
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
  await mock.events.get("context")?.[0]?.({ messages: [] }, context.ctx);

  const result = (await mock.events.get("tool_call")?.[0]?.({ toolName: LATE_TOOL, input: {} }, context.ctx)) as
    | { block?: boolean }
    | undefined;
  assert.equal(result?.block, true);
});

test("session replacement discards pending intent from the replaced workflow", async () => {
  let configured = [LATE_TOOL];
  const allTools = [builtinTool("read")];
  const mock = createMockPi({ activeTools: ["read"], allTools });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, defaultPlanTools: [...configured] },
    }),
  });
  const first = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, first.ctx);
  await mock.commands.get("plan")?.handler("start", first.ctx);

  configured = [];
  const replacement = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, replacement.ctx);
  await mock.commands.get("plan")?.handler("start", replacement.ctx);
  allTools.push(extensionTool(LATE_TOOL));
  mock.rawPi.setActiveTools([...mock.rawPi.getActiveTools(), LATE_TOOL]);
  await mock.events.get("context")?.[0]?.({ messages: [] }, replacement.ctx);

  const result = (await mock.events.get("tool_call")?.[0]?.({ toolName: LATE_TOOL, input: {} }, replacement.ctx)) as
    | { block?: boolean }
    | undefined;
  assert.equal(result?.block, true);
});

test("tree restoration replaces pending intent with the restored selection", async () => {
  let branch: unknown[] = [];
  const allTools = [builtinTool("read")];
  const mock = createMockPi({ activeTools: ["read"], allTools });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, defaultPlanTools: [LATE_TOOL] },
    }),
  });
  const context = createMockContext({
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getEntry: () => undefined,
    },
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  branch = [
    {
      type: "custom",
      customType: "plan-mode-state",
      data: { enabled: true, awaitingAction: false, selectedToolNames: ["read"] },
    },
  ];
  await mock.events.get("session_tree")?.[0]?.({}, context.ctx);
  allTools.push(extensionTool(LATE_TOOL));
  mock.rawPi.setActiveTools([...mock.rawPi.getActiveTools(), LATE_TOOL]);
  await mock.events.get("context")?.[0]?.({ messages: [] }, context.ctx);

  const lateResult = (await mock.events.get("tool_call")?.[0]?.({ toolName: LATE_TOOL, input: {} }, context.ctx)) as
    | { block?: boolean }
    | undefined;
  assert.equal(lateResult?.block, true);
  assert.equal(await mock.events.get("tool_call")?.[0]?.({ toolName: "read", input: {} }, context.ctx), undefined);
});
