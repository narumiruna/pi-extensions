import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { isSafeCommand, isSafePowerShellCommand } from "../src/tool-policy.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const CUSTOM_TOOL = "research_tool";

type ToolCallResult = { block?: boolean; reason?: string } | undefined;

async function startPlan(options: {
  configured?: string[];
  activeTools: string[];
  allTools: ReturnType<typeof builtinTool>[];
}) {
  const mock = createMockPi({ activeTools: options.activeTools, allTools: options.allTools });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: {
        thinkingLevel: "inherit" as const,
        ...(options.configured === undefined ? {} : { defaultPlanTools: options.configured }),
      },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  return { context, mock };
}

async function callTool(fixture: Awaited<ReturnType<typeof startPlan>>, toolName: string, input: unknown = {}) {
  return fixture.mock.events.get("tool_call")?.[0]?.({ toolName, input }, fixture.context.ctx) as ToolCallResult;
}

test("issue 1039: any active extension tool requires explicit Plan-policy opt-in", async () => {
  const automatic = await startPlan({
    activeTools: ["read", CUSTOM_TOOL],
    allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
  });
  assert.deepEqual(await callTool(automatic, CUSTOM_TOOL), {
    block: true,
    reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it is not selected by the Plan policy. Exit Plan mode, then enable it with /plan tools or defaultPlanTools before starting again.`,
  });

  const explicit = await startPlan({
    configured: [CUSTOM_TOOL],
    activeTools: ["read", CUSTOM_TOOL],
    allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
  });
  assert.equal(await callTool(explicit, CUSTOM_TOOL), undefined);
});

test("issue 1039: denied tools report inactive, unavailable, frozen, and blocked policy states", async () => {
  const inactive = await startPlan({
    configured: [CUSTOM_TOOL],
    activeTools: ["read"],
    allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
  });
  assert.deepEqual(await callTool(inactive, CUSTOM_TOOL), {
    block: true,
    reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it is registered but inactive. Activate it before starting the next Plan workflow.`,
  });

  const deactivated = await startPlan({
    configured: [CUSTOM_TOOL],
    activeTools: ["read", CUSTOM_TOOL],
    allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
  });
  await deactivated.mock.events.get("context")?.[0]?.({ messages: [] }, deactivated.context.ctx);
  deactivated.mock.rawPi.setActiveTools(["read", "plan_mode_question", "plan_mode_complete"]);
  assert.deepEqual(await callTool(deactivated, CUSTOM_TOOL), {
    block: true,
    reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it was admitted to the active Plan workflow but is currently inactive. Reactivate it to continue without restarting.`,
  });
  deactivated.mock.rawPi.setActiveTools(["read", CUSTOM_TOOL, "plan_mode_question", "plan_mode_complete"]);
  assert.equal(await callTool(deactivated, CUSTOM_TOOL), undefined);

  const late = await startPlan({
    configured: [CUSTOM_TOOL],
    activeTools: ["read"],
    allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
  });
  late.mock.rawPi.setActiveTools(["read", CUSTOM_TOOL, "plan_mode_question", "plan_mode_complete"]);
  assert.deepEqual(await callTool(late, CUSTOM_TOOL), {
    block: true,
    reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it was not available when the active Plan workflow froze its tool policy. Exit Plan mode, then start again after the tool is active.`,
  });

  const lateAutomatic = await startPlan({
    activeTools: ["read"],
    allTools: [builtinTool("read"), builtinTool("powershell")],
  });
  await lateAutomatic.mock.events.get("context")?.[0]?.({ messages: [] }, lateAutomatic.context.ctx);
  lateAutomatic.mock.rawPi.setActiveTools(["read", "powershell", "plan_mode_question", "plan_mode_complete"]);
  assert.deepEqual(await callTool(lateAutomatic, "powershell"), {
    block: true,
    reason:
      "Plan mode blocks tool 'powershell' because it was not available when the active Plan workflow froze its tool policy. Exit Plan mode, then start again after the tool is active.",
  });

  const unavailable = await startPlan({
    configured: [CUSTOM_TOOL],
    activeTools: ["read"],
    allTools: [builtinTool("read")],
  });
  assert.deepEqual(await callTool(unavailable, CUSTOM_TOOL), {
    block: true,
    reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it is not registered or active. Register and activate it before starting the next Plan workflow.`,
  });

  const metadataFree = await startPlan({
    configured: [CUSTOM_TOOL],
    activeTools: ["read", CUSTOM_TOOL],
    allTools: [builtinTool("read")],
  });
  assert.deepEqual(await callTool(metadataFree, CUSTOM_TOOL), {
    block: true,
    reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because its safe policy metadata is unavailable.`,
  });

  const blockedBuiltin = await startPlan({
    configured: ["danger"],
    activeTools: ["read", "danger"],
    allTools: [builtinTool("read"), builtinTool("danger")],
  });
  assert.deepEqual(await callTool(blockedBuiltin, "danger"), {
    block: true,
    reason: "Plan mode blocks tool 'danger' because its built-in policy is blocked and settings cannot enable it.",
  });
});

test("issue 1039: reviewed git -C inspections stay in Pi's working directory", async () => {
  const workingDirectory = process.cwd();
  const quotedWorkingDirectory = `'${workingDirectory}'`;
  for (const command of [
    "git -C . status --short",
    "git --no-pager -C . log -1 --oneline",
    "git -C . -C . diff --check",
    `git -C ${quotedWorkingDirectory} status --short`,
  ]) {
    assert.equal(isSafeCommand(command, {}, workingDirectory), true, `Bash: ${command}`);
    assert.equal(isSafePowerShellCommand(command, {}, workingDirectory), true, `PowerShell: ${command}`);
  }
  const configured = "git -C . rev-parse --show-toplevel";
  assert.equal(isSafeCommand(configured, {}, workingDirectory), false);
  assert.equal(isSafePowerShellCommand(configured, {}, workingDirectory), false);
  assert.equal(isSafeCommand(configured, { git: ["rev-parse"] }, workingDirectory), true);
  assert.equal(isSafePowerShellCommand(configured, { git: ["rev-parse"] }, workingDirectory), true);

  const fixture = await startPlan({
    activeTools: ["bash", "powershell"],
    allTools: [builtinTool("bash"), builtinTool("powershell")],
  });
  assert.equal(await callTool(fixture, "bash", { command: "git -C . status --short" }), undefined);
  assert.equal(await callTool(fixture, "powershell", { command: "git -C '.' status --short" }), undefined);
});

test("issue 1039: git -C rejects other repositories and unsafe commands", () => {
  const workingDirectory = process.cwd();
  assert.equal(isSafeCommand("git -C . status --short"), false);
  assert.equal(isSafePowerShellCommand("git -C . status --short"), false);
  for (const command of [
    "git -C",
    "git -C --no-pager status",
    "git -C /tmp/repository status --short",
    "git -C packages status --short",
    "git -C packages -C .. status --short",
    "git -C ./packages/.. status --short",
    "git -c core.fsmonitor=false -C . status --short",
    "git -c alias.status=!touch -C . status",
    "git -C . checkout main",
    "git -C . clean -fd",
    "git -C . --exec-path=/tmp status",
    "git -C . diff --ext-diff",
    "git -C . log --show-signature -1",
    "git --git-dir=/tmp/repository status",
  ]) {
    assert.equal(isSafeCommand(command, {}, workingDirectory), false, `Bash: ${command}`);
    assert.equal(isSafePowerShellCommand(command, {}, workingDirectory), false, `PowerShell: ${command}`);
  }
});
