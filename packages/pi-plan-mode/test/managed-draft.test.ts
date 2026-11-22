import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createEditTool,
  createWriteTool,
  type ExtensionContext,
  initTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { DRAFT_CONTRACT_TYPE, type DraftAuthorization, reconcileDraftContract } from "../src/draft-contract.js";
import type { PlanModeSettings } from "../src/settings.js";
import type { PlanModeState } from "../src/state.js";
import { createPlanPaneHost, PANE_KEY } from "./plan-pane-support.js";
import { createMockContext, createMockPi } from "./support.js";

function customDraftMessage(value: unknown) {
  return (value as { customType?: string })?.customType === DRAFT_CONTRACT_TYPE;
}

async function fixture(
  options: {
    settings?: PlanModeSettings;
    inactive?: string;
    overridden?: string;
    mode?: "tui" | "rpc" | "print" | "json";
  } = {},
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-managed-draft-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const mode = options.mode ?? "tui";
  if (mode === "tui") initTheme("dark");
  const terminal = mode === "tui" ? createPlanPaneHost() : undefined;
  const toolNames = ["read", "write", "edit", "bash"];
  const allTools = toolNames.map((name) => ({
    name,
    exposure: "direct",
    sourceInfo:
      name === options.overridden
        ? { source: "extension", scope: "user", path: join(dir, "override.ts") }
        : { source: "builtin", scope: "builtin", path: `builtin:${name}` },
  }));
  const mock = createMockPi({ activeTools: toolNames.filter((name) => name !== options.inactive), allTools });
  let sessionId = "draft-fixture";
  let branch: unknown[] = [];
  let entriesStart = 0;
  const context = createMockContext({
    cwd: dir,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [...branch, ...mock.entries.slice(entriesStart).map((entry) => ({ type: "custom", ...entry }))],
    },
  });
  const ctx: ExtensionContext = context.ctx;
  if (terminal) {
    const setWidget = ctx.ui.setWidget;
    ctx.ui.setWidget = ((...args: Parameters<ExtensionContext["ui"]["setWidget"]>) => {
      setWidget(...args);
      terminal.setWidget(...args);
    }) as ExtensionContext["ui"]["setWidget"];
  }
  const module = await import("../src/plan-mode.js");
  module.default(mock.pi, {
    readSettings: async () => (options.settings ? { kind: "loaded", settings: options.settings } : { kind: "missing" }),
  });
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const hook of mock.events.get(name) ?? []) result = await hook(event, ctx);
    return result;
  };
  await emit("session_start", { reason: "startup" });
  const command = mock.commands.get("plan");
  assert.ok(command);
  const invoke = (args: string) => command.handler(args, ctx as Parameters<typeof command.handler>[1]);
  const tool = mock.tools.find(({ name }) => name === "plan_mode_complete");
  assert.ok(tool);
  const execute = tool.execute as (...args: unknown[]) => Promise<{ details: { plan: string } }>;
  await invoke("start");
  const currentMessages = (): unknown[] =>
    mock.sentMessages.map(({ message }) => ({ role: "custom", timestamp: 0, ...(message as object) }));
  const applyContext = async (messages: unknown[] = currentMessages()) =>
    ((await emit("context", { messages })) as { messages: unknown[] }).messages;
  const currentState = () =>
    mock.entries.filter((entry) => entry.customType === "plan-mode-state").at(-1)?.data as PlanModeState;
  return {
    ctx,
    mock,
    widgets: context.widgets,
    dir,
    emit,
    invoke,
    currentState,
    allTools,
    applyContext,
    currentMessages,
    frame: async () => {
      await Promise.resolve();
      return terminal?.render().map(stripTerminalSequences).join("\n") ?? "";
    },
    draftPath() {
      const draft = currentState().draft;
      assert.ok(draft);
      return join(dir, "pi-plan-mode", "drafts", draft.workflowId, "plan.md");
    },
    call: (toolName: string, path: unknown, toolCallId = "call", parentToolCallId?: string) =>
      emit("tool_call", { toolName, toolCallId, input: { path }, parentToolCallId }),
    end: (toolName: string, toolCallId: string, isError = false) =>
      emit("tool_execution_end", { toolName, toolCallId, isError }),
    complete: (params: unknown = {}) => execute("complete", params, undefined, undefined, ctx),
    async changeBranch(data: PlanModeState, id = sessionId, event = "session_tree") {
      sessionId = id;
      entriesStart = mock.entries.length;
      branch = [{ type: "custom", customType: "plan-mode-state", data }];
      await emit(event, { reason: "resume" });
    },
    async close() {
      await emit("session_shutdown", { reason: "quit" });
      terminal?.stop();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test.each(["right", "left", "off"] as const)(
  "native write and edit refresh the draft pane configured %s",
  async (planPane) => {
    const f = await fixture({ settings: { thinkingLevel: "inherit", planPane } });
    try {
      await f.applyContext();
      const path = f.draftPath();
      assert.equal(f.widgets.has(PANE_KEY), planPane !== "off");
      assert.equal((await f.frame()).includes("Waiting for the Markdown draft"), planPane !== "off");
      assert.equal(await f.call("write", path, "write"), undefined);
      const raw = "# 草稿\n\n\u202eChecklist\n";
      await createWriteTool(f.dir).execute("write", { path, content: raw });
      await f.end("write", "write");
      assert.equal((await f.frame()).includes("草稿"), planPane !== "off");
      assert.doesNotMatch(await f.frame(), /\u202e|Show Markdown|@@/u);
      assert.equal(await f.call("edit", path, "edit"), undefined);
      await createEditTool(f.dir).execute("edit", { path, edits: [{ oldText: "草稿", newText: "新版" }] });
      await f.end("edit", "edit");
      const revised = raw.replace("草稿", "新版");
      const changes = await f.frame();
      assert.equal(changes.includes("-# 草稿"), planPane !== "off");
      assert.equal(changes.includes("+# 新版"), planPane !== "off");
      assert.doesNotMatch(changes, /\u202e/u);
      assert.equal(await readFile(path, "utf8"), revised);
      const completed = await f.complete({ plan: "Wrong plan" });
      assert.equal(completed.details.plan, revised);
      assert.equal((await f.frame()).includes("Plan · Ready"), planPane !== "off");
      assert.doesNotMatch(await f.frame(), /草稿|Show Markdown|@@/u);
      assert.equal(await readFile(path, "utf8"), revised);
      assert.deepEqual(await f.call("write", path), {
        block: true,
        reason: "Only direct, active Pi native tools may change an unfinished Plan draft.",
      });
      const ready = f.currentState();
      await writeFile(path, "Changed draft");
      await f.changeBranch(ready);
      assert.equal((await f.frame()).includes("新版"), planPane !== "off");
      await f.emit("before_agent_start", { messageType: "user" });
      assert.equal((await f.frame()).includes("Changed draft"), planPane !== "off");
      if (planPane === "off") assert.equal((await f.frame()).includes("│"), false);
    } finally {
      await f.close();
    }
  },
);

test("admission rejects aliases, nested calls, reclassified tools, and unsafe filesystem entries", async () => {
  const f = await fixture();
  try {
    await f.applyContext();
    const path = f.draftPath();
    const rejected = async (input: unknown, parent?: string) => {
      const result = (await f.call("write", input, "call", parent)) as { block?: boolean };
      assert.equal(result?.block, true);
    };
    for (const bad of [
      null,
      "plan.md",
      `@${path}`,
      `${dirname(path)}/./plan.md`,
      `file://${path}`,
      join(f.dir, "other.md"),
    ])
      await rejected(bad);
    await rejected(path, "orchestrator");
    assert.equal(
      ((await f.call("plan_mode_complete", undefined, "nested", "orchestrator")) as { block?: boolean }).block,
      true,
    );
    const tool = f.allTools.find(({ name }) => name === "write");
    assert.ok(tool);
    tool.exposure = "hidden";
    await rejected(path);
    tool.exposure = "direct";
    const oldSource = tool.sourceInfo;
    tool.sourceInfo = { source: "extension", scope: "user", path: join(f.dir, "write.ts") };
    await rejected(path);
    tool.sourceInfo = oldSource;
    f.mock.rawPi.setActiveTools(f.mock.rawPi.getActiveTools().filter((name) => name !== "write"));
    await rejected(path);
    f.mock.rawPi.setActiveTools([...f.mock.rawPi.getActiveTools(), "write"]);
    assert.equal(await f.call("write", path), undefined);
    await f.end("write", "call", true);
    const outside = join(f.dir, "outside.md");
    await writeFile(outside, "do not touch");
    await link(outside, path);
    await rejected(path);
    await rm(path);
    if (process.platform !== "win32") {
      await symlink(outside, path);
      await rejected(path);
      await rm(path);
    }
    await mkdir(path);
    await rejected(path);
    await rm(path, { recursive: true });
    const workflowDirectory = dirname(path);
    if (process.platform !== "win32") assert.equal((await lstat(workflowDirectory)).mode & 0o777, 0o700);
    const moved = `${workflowDirectory}-moved`;
    await rename(workflowDirectory, moved);
    await symlink(moved, workflowDirectory, "junction");
    await rejected(path);
    await assert.rejects(f.complete(), /private, canonical directory/u);
    assert.equal(await readFile(outside, "utf8"), "do not touch");
  } finally {
    await f.close();
  }
});

test.each([
  { inactive: "edit" },
  { overridden: "read" },
  { settings: { thinkingLevel: "inherit", defaultPlanTools: ["read", "write", "edit"] } as const },
])("ineligible workflow stays read-only after first context: %j", async (options) => {
  const settings =
    "settings" in options && options.settings
      ? { thinkingLevel: options.settings.thinkingLevel, defaultPlanTools: [...options.settings.defaultPlanTools] }
      : undefined;
  const f = await fixture({ ...options, settings });
  try {
    assert.ok(!(await f.applyContext()).some(customDraftMessage));
    assert.equal(f.currentState().draft, undefined);
    f.mock.rawPi.setActiveTools([...f.mock.rawPi.getActiveTools(), "edit"]);
    assert.equal(((await f.call("edit", join(f.dir, "plan.md"))) as { block?: boolean })?.block, true);
    await assert.rejects(f.complete(), /plan must be a string/u);
    assert.equal((await f.complete({ plan: " # Legacy plan " })).details.plan, "# Legacy plan");
    await assert.rejects(lstat(join(f.dir, "pi-plan-mode", "drafts")), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("draft admission retries with the same workflow ID after state persistence fails", async () => {
  const f = await fixture({ mode: "rpc" });
  const append = f.mock.rawPi.appendEntry;
  let failuresRemaining = 2;
  vi.spyOn(f.mock.rawPi, "appendEntry").mockImplementation((type, data) => {
    if (type === "plan-mode-state" && (data as PlanModeState).draft?.status === "active" && failuresRemaining > 0) {
      failuresRemaining -= 1;
      throw new Error("Cannot save draft admission");
    }
    append(type, data);
  });
  try {
    const path = f.draftPath();
    const workflowId = f.currentState().draft?.workflowId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(f.applyContext(), /Cannot save draft admission/u);
      assert.equal(f.currentState().draft?.status, "pending");
      assert.equal(((await f.call("write", path)) as { block?: boolean })?.block, true);
      assert.ok(!f.mock.entries.some(({ customType }) => customType === DRAFT_CONTRACT_TYPE));
      await assert.rejects(lstat(dirname(path)), { code: "ENOENT" });
    }
    const messages = await f.applyContext();
    assert.equal(f.currentState().draft?.status, "active");
    assert.equal(f.currentState().draft?.workflowId, workflowId);
    assert.equal(f.draftPath(), path);
    assert.equal(messages.filter(customDraftMessage).length, 1);
    assert.equal(await f.call("write", path, "retry"), undefined);
    await createWriteTool(f.dir).execute("retry", { path, content: "# Recovered draft" });
    await f.end("write", "retry");
    assert.equal((await f.complete()).details.plan, "# Recovered draft");
  } finally {
    await f.close();
  }
});

test.each(["not empty", "replaced"] as const)(
  "admission rollback leaves a workflow directory intact when it is %s",
  async (change) => {
    const f = await fixture({ mode: "rpc" });
    const path = f.draftPath();
    const directory = dirname(path);
    const append = f.mock.rawPi.appendEntry;
    vi.spyOn(f.mock.rawPi, "appendEntry").mockImplementation((type, data) => {
      if (type === "plan-mode-state" && (data as PlanModeState).draft?.status === "active") {
        if (change === "not empty") writeFileSync(path, "Retain this file");
        else {
          renameSync(directory, `${directory}-moved`);
          mkdirSync(directory, { mode: 0o700 });
        }
        throw new Error("Cannot save draft admission");
      }
      append(type, data);
    });
    try {
      await assert.rejects(f.applyContext(), /Cannot save draft admission/u);
      assert.ok((await lstat(directory)).isDirectory());
      if (change === "not empty") assert.equal(await readFile(path, "utf8"), "Retain this file");
      assert.ok(!(await f.applyContext()).some(customDraftMessage));
      assert.equal(f.currentState().draft, undefined);
      assert.equal(((await f.call("write", path)) as { block?: boolean })?.block, true);
    } finally {
      await f.close();
    }
  },
);

test("first-request storage failure is read-only; a fork cannot write the source session's draft", async () => {
  const f = await fixture({ mode: "rpc" });
  try {
    await writeFile(join(f.dir, "pi-plan-mode"), "blocked directory");
    await f.applyContext();
    assert.equal(f.currentState().draft, undefined);
    await f.invoke("exit");
    await rm(join(f.dir, "pi-plan-mode"));
    await f.invoke("start");
    await f.applyContext();
    const path = f.draftPath();
    const original = f.currentState();
    await writeFile(path, "one session only");
    await f.changeBranch(original, "fork", "session_start");
    const projected = await f.applyContext();
    assert.match(JSON.stringify(projected.at(-1)), /No draft is writable in this session/u);
    assert.equal(((await f.call("write", path)) as { block?: boolean }).block, true);
    assert.equal((await f.complete({ plan: "Fork's legacy plan" })).details.plan, "Fork's legacy plan");
    assert.equal(await readFile(path, "utf8"), "one session only");
    assert.equal(f.widgets.has(PANE_KEY), false);
    assert.equal(f.mock.sentUserMessages.length, 0);
  } finally {
    await f.close();
  }
});

test("invalid draft reads are recoverable and the last write is reread after cancellation", async () => {
  const f = await fixture();
  try {
    await f.applyContext();
    const path = f.draftPath();
    await assert.rejects(f.complete(), /Write the decision-ready Markdown draft/u);
    assert.equal(await f.call("write", path, "first"), undefined);
    await assert.rejects(f.complete(), /Wait for draft writes/u);
    await writeFile(path, " \n");
    await f.end("write", "first");
    await assert.rejects(f.complete(), /must not be empty/u);
    for (const text of ["一".repeat(18_000), "*\n".repeat(2001), "s".repeat(50_001)]) {
      assert.equal(await f.call("write", path), undefined);
      await writeFile(path, text);
      await f.end("write", "call");
      assert.match(await f.frame(), /Keep the draft within/u);
      await assert.rejects(f.complete(), /Keep the draft within/u);
    }
    assert.equal(await f.call("write", path, "recovery"), undefined);
    await writeFile(path, "# Recovered draft\n");
    await f.end("write", "recovery");
    assert.match(await f.frame(), /Recovered draft/u);
    assert.doesNotMatch(await f.frame(), /Show Markdown|@@/u);
    const abort = new AbortController();
    Object.assign(f.ctx, { signal: abort.signal });
    assert.equal(await f.call("write", path, "cancelled"), undefined);
    await writeFile(path, "# Landed before abort");
    abort.abort();
    await f.end("write", "cancelled", true);
    assert.doesNotMatch(await f.frame(), /Landed/u);
    await f.emit("agent_settled");
    assert.match(await f.frame(), /-# Recovered draft/u);
    assert.match(await f.frame(), /\+# Landed before abort/u);
    Object.assign(f.ctx, { signal: undefined });
    assert.equal((await f.complete()).details.plan, "# Landed before abort");
  } finally {
    await f.close();
  }
});

test.each(["exit", "shutdown"] as const)("a pending draft preview cannot redraw after %s", async (boundary) => {
  const f = await fixture();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let unlock: Promise<void> | undefined;
  try {
    await f.applyContext();
    const path = f.draftPath();
    assert.equal(await f.call("write", path, "baseline"), undefined);
    await writeFile(path, "# Previous draft");
    await f.end("write", "baseline");
    assert.match(await f.frame(), /Previous draft/u);
    const entered = new Promise<void>((resolve) => {
      unlock = withFileMutationQueue(path, async () => {
        resolve();
        await hold;
        await writeFile(path, "# Last bytes");
      });
    });
    await entered;
    assert.equal(await f.call("write", path, "write"), undefined);
    const refresh = f.end("write", "write");
    assert.doesNotMatch(await f.frame(), /Last bytes/u);
    if (boundary === "exit") await f.invoke("exit");
    else await f.emit("session_shutdown", { reason: "reload" });
    release();
    await refresh;
    assert.doesNotMatch(await f.frame(), /Last bytes|Previous draft|Show Markdown|│/u);
  } finally {
    release();
    await unlock;
    await f.close();
  }
});

test("serialized mutations publish the newest draft and same-session reload reads the file", async () => {
  const f = await fixture();
  try {
    await f.applyContext();
    const path = f.draftPath();
    assert.equal(await f.call("write", path, "baseline"), undefined);
    await writeFile(path, "# Visible baseline");
    await f.end("write", "baseline");
    assert.match(await f.frame(), /Visible baseline/u);
    await f.call("write", path, "first");
    await f.call("write", path, "second");
    const tool = createWriteTool(f.dir);
    const first = tool.execute("first", { path, content: "# Earlier text" });
    const second = tool.execute("second", { path, content: "# Newest text" });
    await first;
    await f.end("write", "first");
    assert.doesNotMatch(await f.frame(), /Earlier text/u);
    await second;
    await f.end("write", "second");
    assert.match(await f.frame(), /-# Visible baseline/u);
    assert.match(await f.frame(), /\+# Newest text/u);
    assert.doesNotMatch(await f.frame(), /Earlier text/u);
    const state = f.currentState();
    await writeFile(path, "# Reloaded draft");
    await f.emit("session_shutdown", { reason: "reload" });
    await f.changeBranch(state, undefined, "session_start");
    assert.match(await f.frame(), /Reloaded draft/u);
    assert.doesNotMatch(await f.frame(), /Show Markdown|Newest text/u);
    assert.equal(await f.call("write", path), undefined);
  } finally {
    await f.close();
  }
});

test("a read-only successor supersedes the prior workflow's writable draft grant", async () => {
  const f = await fixture();
  try {
    const first = await f.applyContext();
    const path = f.draftPath();
    assert.match(JSON.stringify(first.at(-1)), /exact absolute path/u);
    await f.invoke("exit");
    f.mock.rawPi.setActiveTools(f.mock.rawPi.getActiveTools().filter((name) => name !== "edit"));
    await f.invoke("start");
    const messages = f.currentMessages();
    const next = await f.applyContext(messages);
    assert.deepEqual(next.slice(0, first.length), first);
    assert.equal(next.filter(customDraftMessage).length, 2);
    assert.match(JSON.stringify(next.at(-1)), /No draft is writable in this session/u);
    assert.deepEqual(await f.applyContext(structuredClone(next)), next);
    assert.equal(((await f.call("write", path)) as { block?: boolean }).block, true);
    await assert.rejects(f.complete(), /plan must be a string/u);
    const compacted = [{ role: "compactionSummary", summary: "Earlier plan discussion", timestamp: 1 }];
    const afterCompaction = await f.applyContext(compacted);
    assert.equal(afterCompaction.filter(customDraftMessage).length, 1);
    assert.match(JSON.stringify(afterCompaction.at(-1)), /No draft is writable in this session/u);
    assert.equal((await f.complete({ plan: "# Read-only successor" })).details.plan, "# Read-only successor");
  } finally {
    await f.close();
  }
});

test("replaying retained draft contracts preserves both the historical grant and its later override", () => {
  const branch: unknown[] = [];
  const replay = (messages: unknown[], expected: DraftAuthorization) =>
    reconcileDraftContract(messages, branch, expected, (data) => {
      branch.push({ type: "custom", customType: DRAFT_CONTRACT_TYPE, data });
    });
  const user = { role: "user", content: "Draft the plan" };
  const fork = { role: "user", content: "Continue the plan in this fork" };
  const original = replay([user], { kind: "unavailable" });
  const overridden = replay([...original, fork], { kind: "read-only" });
  assert.equal(branch.length, 2);
  assert.equal(overridden.filter(customDraftMessage).length, 2);
  for (const input of [[user, fork], [...original, fork], structuredClone(overridden)]) {
    assert.deepEqual(replay(input, { kind: "read-only" }), overridden);
    assert.equal(branch.length, 2);
  }
});

test("compaction reanchors the grant at the tail exactly once and shutdown clears the pane", async () => {
  const f = await fixture();
  try {
    const messages = await f.applyContext();
    assert.equal(messages.filter(customDraftMessage).length, 1);
    assert.deepEqual(await f.applyContext(structuredClone(messages)), messages);
    const firstBranch = f.currentMessages();
    const next = { role: "user", content: "next question", timestamp: 1 };
    const later = await f.applyContext([...firstBranch, next]);
    assert.deepEqual(later.slice(0, messages.length), messages);
    const compacted = [{ role: "compactionSummary", summary: "Compacted conversation", timestamp: 2 }];
    const restored = await f.applyContext(compacted);
    assert.equal(restored.filter(customDraftMessage).length, 1);
    assert.ok(customDraftMessage(restored.at(-1)));
    const nextAfter = await f.applyContext([...compacted, next]);
    assert.deepEqual(nextAfter.slice(0, restored.length), restored);
    assert.deepEqual(await f.applyContext(structuredClone(nextAfter)), nextAfter);
    assert.ok(f.mock.entries.filter(({ customType }) => customType === DRAFT_CONTRACT_TYPE).length === 2);
    await f.emit("session_shutdown", { reason: "reload" });
    assert.doesNotMatch(await f.frame(), /│/u);
    assert.equal(f.widgets.get(PANE_KEY), undefined);
    assert.equal(f.mock.sentUserMessages.length, 0);
  } finally {
    await f.close();
  }
});
