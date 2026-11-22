import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { showPlanLaunchMenu } from "../src/plan-launch-menu.js";
import planMode from "../src/plan-mode.js";
import { showPlanModeSettings } from "../src/settings-menu.js";
import { planModeToolSelection } from "../src/tool-selection.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const tools = ["read", "grep", "find", "ls", "edit", "write"].map(builtinTool) as ToolInfo[];
tools.push(extensionTool("custom") as ToolInfo);
const active = ["read", "edit", "plan_mode_question", "plan_mode_update", "plan_mode_complete"];

test("published activation examples separate full selection from Pi 0.99+ modifiers", async () => {
  const reference = await readFile(resolve("packages/pi-plan-mode/docs/settings.md"), "utf8");
  const activation = reference
    .split("### Enable inactive built-in search tools in Pi")[1]
    ?.split("### Plan reinjection")[0];
  assert.ok(activation);
  const examples = [...activation.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.deepEqual(examples, [
    { defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
    { defaultTools: ["+grep", "+find", "+ls"] },
  ]);
  assert.match(activation, /Pi 0\.99 or newer only/);
  assert.match(activation, /Do not use modifiers on older releases/);
  assert.match(activation, /custom or in-memory `SettingsManager`/);
});

for (const name of ["grep", "find", "ls"]) {
  test(`inactive built-in ${name} explains Pi activation without changing metadata`, () => {
    const tool = builtinTool(name) as ToolInfo;
    const before = JSON.stringify(tool);
    for (const retained of [false, true]) {
      const presentation = planModeToolSelection(tool, new Set(), retained);
      assert.equal(presentation.disabled, true);
      assert.match(presentation.label ?? "", /inactive in Pi/);
      assert.ok(presentation.disabledReason?.includes(`"${name}"`));
      assert.ok(presentation.disabledReason?.includes("defaultTools"));
      assert.match(presentation.disabledReason ?? "", /this session's Pi settings/);
      assert.match(presentation.disabledReason ?? "", /full.*preserve existing\/default tools/);
      assert.doesNotMatch(presentation.disabledReason ?? "", /settings\.json|"\+(grep|find|ls)"/);
      assert.match(presentation.disabledReason ?? "", /restart Pi/);
      if (retained) assert.match(presentation.disabledReason ?? "", /retained/i);
    }
    assert.equal(JSON.stringify(tool), before);
  });
}

for (const name of ["edit", "write"]) {
  for (const isActive of [false, true]) {
    test(`${name}: policy-blocked status takes precedence over inactive=${!isActive}`, () => {
      const presentation = planModeToolSelection(builtinTool(name) as ToolInfo, new Set(isActive ? [name] : []), true);
      assert.equal(presentation.disabled, true);
      assert.match(presentation.label ?? "", /blocked by Plan policy/);
      assert.equal(presentation.disabledReason, "Blocked by Plan-mode policy");
      assert.doesNotMatch(presentation.description, /Not active/);
      assert.doesNotMatch(presentation.disabledReason ?? "", /defaultTools/);
    });
  }
}

test("active tools stay selectable and inactive custom overrides do not get built-in activation advice", () => {
  for (const tool of [builtinTool("read"), builtinTool("grep"), extensionTool("custom"), extensionTool("grep")]) {
    const before = JSON.stringify(tool);
    const available = planModeToolSelection(tool as ToolInfo, new Set([tool.name]), false);
    assert.equal(available.disabled, false);
    assert.equal(available.label, tool.name);
    assert.equal(available.disabledReason, undefined);
    if (tool.sourceInfo.source !== "builtin") {
      const inactive = planModeToolSelection(tool as ToolInfo, new Set(), false);
      assert.equal(inactive.disabled, true);
      assert.match(inactive.label ?? "", /inactive in Pi/);
      assert.doesNotMatch(inactive.disabledReason ?? "", /defaultTools/);
    }
    assert.equal(JSON.stringify(tool), before);
  }
});

test("Settings guidance is bounded, sanitized, and display-only with remapped keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-guidance-"));
  const settingsPath = join(directory, "pi-plan-mode.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const styles: { role: string; text: string }[] = [];
  const tui = createTuiHarness({
    theme: {
      fg: (role, text) => {
        styles.push({ role, text });
        return text;
      },
      bold: (text) => text,
    },
    width: 72,
    rows: 40,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": "alt+s",
      "tui.select.cancel": "alt+q",
    }),
  });
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent\u001b[31m\u202e");
  const unsafeTool = extensionTool("custom\u001b[31m\u202e") as ToolInfo;
  unsafeTool.description = "Description\u001b]52;c;payload\u0007\u202e";
  unsafeTool.sourceInfo.path = "owner\u001b[31m\u202e/path";
  const menuTools = [...tools, unsafeTool];
  const before = JSON.stringify(menuTools);
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const saved: unknown[] = [];
  let running: Promise<unknown> | undefined;
  const frames: string[] = [];
  const bounded: boolean[] = [];
  try {
    running = showPlanModeSettings(context.ctx, {
      settingsPath,
      tools: menuTools,
      activeToolNames: [...active, unsafeTool.name],
      signal: new AbortController().signal,
      isCurrent: () => true,
      onSaved: (settings) => saved.push(settings),
    });
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.send("\u001bs");
    await tui.waitForPending();
    await tui.waitForOpen();
    for (let index = 0; index < menuTools.length; index += 1) {
      frames.push(tui.render(72).join("\n"));
      bounded.push(tui.render(34).every((line) => visibleWidth(line) <= 34));
      // Only read and the final custom tool are active; disabled rows must not save.
      if (index > 0 && index < menuTools.length - 1) tui.send("\u001bs");
      tui.press("tui.select.down");
    }
    await assert.rejects(access(settingsPath));
  } finally {
    tui.press("ctrl+c");
    await running;
    tui.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
  const display = frames.join("\n");
  assert.match(display, /grep — inactive in Pi/);
  assert.match(display, /write — blocked by Plan policy/);
  assert.match(display, /defaultTools/);
  assert.match(display, /restart Pi/);
  assert.match(display, /owner\/path/);
  assert.ok(styles.some(({ role, text }) => role === "dim" && text.includes("defaultTools")));
  assert.ok(styles.some(({ role, text }) => role === "dim" && text.includes("ctrl+c")));
  assert.ok(bounded.every(Boolean));
  assert.doesNotMatch(display, /\u202e|\]52;c;payload|\[31m/);
  assert.equal(JSON.stringify(menuTools), before);
  assert.deepEqual(saved, []);
});

test("launch picker sanitizes metadata before search while retaining colliding raw tool identities", async () => {
  const unsafeName = "custom\u001b[31m\u202e";
  const tool = extensionTool(unsafeName) as ToolInfo;
  tool.sourceInfo.path = "ow\u001b[31mner\u202e/path";
  tool.description = "Inspect\u001b]52;c;payload\u0007";
  const before = JSON.stringify(tool);
  const launchTools = [extensionTool("custom") as ToolInfo, tool].map((item) => ({
    name: item.name,
    ...planModeToolSelection(item, new Set(["custom", unsafeName]), false),
  }));
  const tui = createTuiHarness({ width: 72, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const accepted: string[][] = [];
  let frame = "";
  let filtered = "";
  let bounded = false;
  const running = showPlanLaunchMenu(context.ctx, {
    statusText: "Off",
    toolSummary: () => "None selected",
    getSelectedNames: () => new Set(),
    tools: launchTools,
    signal: new AbortController().signal,
    isCurrent: () => true,
    initialScreen: "tools",
    start: () => assert.fail("unexpected start without selection"),
    startWithTools: (names) => accepted.push(names),
    settings: async () => false,
  });
  try {
    await tui.waitForOpen();
    tui.press("tui.select.down");
    frame = tui.render().join("\n");
    bounded = tui.render(34).every((line) => visibleWidth(line) <= 34);
    tui.send("owner/path");
    filtered = tui.render(72).join("\n");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await running;
  } finally {
    tui.dispose();
  }
  assert.match(frame, /owner\/path/);
  assert.match(filtered, /\[ \] custom/);
  assert.doesNotMatch(frame + filtered, /\u202e|\]52;c;payload|\[31m/);
  assert.ok(bounded);
  assert.deepEqual(accepted, [[unsafeName]]);
  assert.equal(JSON.stringify(tool), before);
});

for (const route of ["settings", "tools"]) {
  test(`RPC /plan ${route} distinguishes active, inactive, blocked, and pending without activation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-plan-guidance-rpc-"));
    const settingsPath = join(directory, "pi-plan-mode.json");
    const retained = ["grep", "custom", "pending\u001b[31m"];
    const original = JSON.stringify({ defaultPlanTools: retained, unknown: { keep: true } });
    const mock = createMockPi({ allTools: tools, activeTools: active });
    const before = JSON.stringify(tools);
    const rpc = createRpcHarness([
      ...(route === "settings" ? [{ kind: "select" as const, response: "Plan policy tools (3 selected)" }] : []),
      { kind: "select", response: undefined },
      ...(route === "settings" ? [{ kind: "select" as const, response: undefined }] : []),
    ]);
    const context = createMockContext({ mode: "rpc", hasUI: true, cwd: directory, ...rpc.ui });
    planMode(mock.pi, { settingsPath });
    try {
      await writeFile(settingsPath, original);
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await mock.commands.get("plan")?.handler(route, context.ctx);
      rpc.assertConsumed();
      const options = rpc.dialogs[route === "settings" ? 1 : 0]?.options ?? [];
      assert.deepEqual(
        context.notifications.filter(({ level }) => level === "error"),
        [],
      );
      assert.ok(options.includes("[ ] read"));
      assert.ok(options.some((option) => /grep — inactive in Pi.*defaultTools.*restart Pi/.test(option)));
      assert.ok(options.some((option) => /custom — inactive in Pi.*retained/i.test(option)));
      assert.ok(options.some((option) => /write — blocked by Plan policy.*Blocked by Plan-mode policy/.test(option)));
      assert.ok(options.some((option) => /pending.*Not registered yet/.test(option)));
      assert.ok(options.every((option) => !option.includes("\u001b") && !option.includes("\u202e")));
      assert.deepEqual(mock.rawPi.getActiveTools(), active);
      assert.equal(JSON.stringify(tools), before);
      assert.deepEqual(mock.entries, []);
      assert.deepEqual(mock.sentUserMessages, []);
      assert.equal(await readFile(settingsPath, "utf8"), original);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
