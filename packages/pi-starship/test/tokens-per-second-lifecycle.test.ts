import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { onTestFinished, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const document = 'format = "$tokens_per_second"\n[tokens_per_second]\ndisabled = false\n';
type AssistantResponse = Extract<Parameters<SessionManager["appendMessage"]>[0], { role: "assistant" }>;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

function response(
  output = 85,
  durationMs: number | undefined = 2000,
  stopReason: AssistantResponse["stopReason"] = "stop",
): AssistantResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "completed" }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    timestamp: 1,
    durationMs,
    stopReason,
    usage: {
      input: 10,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10 + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function setup(mode: ExtensionContext["mode"] = "tui") {
  const root = mkdtempSync(join(tmpdir(), "starship-tokens-per-second-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, document);
  const contexts: ReturnType<typeof createMockContext>[] = [];
  const components: ReturnType<FooterFactory>[] = [];
  const mock = createMockPi();
  const emit = async (name: string, context: ReturnType<typeof createMockContext>, event: unknown = {}) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, context.ctx);
  };
  onTestFinished(async () => {
    try {
      for (const context of contexts) await emit("session_shutdown", context);
      for (const component of components) component.dispose?.();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
  vi.resetModules();
  const [{ SessionManager }, { default: piStarship }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("../src/pi-starship.js"),
  ]);
  const exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 1, killed: false, truncated: false }));
  piStarship(mock.pi, { gitExec: exec, githubPrExec: exec });
  const createContext = (manager: SessionManager) => {
    const context = createMockContext({ mode, sessionManager: manager });
    contexts.push(context);
    return context;
  };
  const manager = SessionManager.inMemory("/workspace");
  const context = createContext(manager);
  const mount = (target = context) => {
    assert.equal(typeof target.footer, "function");
    const requestRender = vi.fn();
    const unsubscribe = vi.fn();
    const component = (target.footer as FooterFactory)(
      { requestRender } as never,
      { colors: {} } as never,
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => unsubscribe,
      } as never,
    );
    components.push(component);
    return {
      component,
      requestRender,
      unsubscribe,
      text: () => stripVTControlCharacters(component.render(80).join("\n")),
    };
  };
  await emit("session_start", context);
  return { path, mock, exec, manager, context, createContext, mount, emit, SessionManager };
}

test("persisted assistant responses update the footer at existing turn boundaries without estimating partial output", async () => {
  const state = await setup();
  const footer = state.mount();
  assert.equal(footer.text(), "");
  await state.emit("turn_start", state.context);
  await state.emit("message_update", state.context, { message: response(999, 1, "pending") });
  assert.equal(footer.text(), "");

  state.manager.appendMessage(response(120, 2000));
  const renders = footer.requestRender.mock.calls.length;
  await state.emit("turn_end", state.context);
  assert.ok(footer.requestRender.mock.calls.length > renders);
  assert.equal(footer.text(), "60.0 tok/s ");
  await state.emit("turn_start", state.context);
  await state.emit("message_update", state.context, { message: response(999, 1, "pending") });
  assert.equal(footer.text(), "60.0 tok/s ");

  state.manager.appendMessage(response());
  await state.emit("turn_end", state.context);
  assert.equal(footer.text(), "42.5 tok/s ");
  assert.equal(readFileSync(state.path, "utf8"), document);
  assert.deepEqual(state.mock.entries, []);
  assert.equal(state.exec.mock.calls.length, 0);
});

test("tool-calling response throughput is available during tool execution without adding tool duration or usage", async () => {
  const state = await setup();
  const footer = state.mount();
  state.manager.appendMessage(response(85, 2000, "toolUse"));
  await state.emit("tool_execution_start", state.context, { toolName: "read" });
  assert.equal(footer.text(), "42.5 tok/s ");
  state.manager.appendMessage({
    role: "toolResult",
    toolCallId: "call",
    toolName: "read",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 10_000,
    durationMs: 8000,
    usage: response(10_000, 1).usage,
  });
  await state.emit("tool_execution_end", state.context, { toolName: "read" });
  assert.equal(footer.text(), "42.5 tok/s ");
});

test.each(["error", "aborted", "deferred"] as const)(
  "a finalized %s response hides the previous rate",
  async (stopReason) => {
    const state = await setup();
    state.manager.appendMessage(response());
    const footer = state.mount();
    assert.equal(footer.text(), "42.5 tok/s ");
    state.manager.appendMessage(response(10, 2000, stopReason));
    await state.emit("turn_end", state.context);
    await state.emit("agent_end", state.context);
    assert.equal(footer.text(), "");
  },
);

test.each(["resume", "reload", "fork"])(
  "session %s restores its persisted rate and leaves untimed legacy responses empty",
  async (reason) => {
    const state = await setup();
    state.manager.appendMessage(response());
    await state.emit("session_start", state.context, { reason });
    assert.equal(state.mount().text(), "42.5 tok/s ");
    const legacy = response();
    delete legacy.durationMs;
    state.manager.appendMessage(legacy);
    await state.emit("session_start", state.context, { reason });
    assert.equal(state.mount().text(), "");
  },
);

test("tree navigation uses the active branch instead of the newest response on an abandoned branch", async () => {
  const state = await setup();
  const user = state.manager.appendMessage({ role: "user", content: "prompt", timestamp: 0 });
  const first = state.manager.appendMessage(response());
  const old = state.mount();
  assert.equal(old.text(), "42.5 tok/s ");
  state.manager.branch(user);
  await state.emit("session_tree", state.context);
  assert.equal(old.unsubscribe.mock.calls.length, 1);
  const branch = state.mount();
  assert.equal(branch.text(), "");
  state.manager.appendMessage(response(120, 2000));
  await state.emit("turn_end", state.context);
  assert.equal(branch.text(), "60.0 tok/s ");
  state.manager.branch(first);
  await state.emit("session_tree", state.context);
  assert.equal(state.mount().text(), "42.5 tok/s ");
  assert.equal(
    state.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length,
    2,
  );
});

test("replacement sessions and repeated shutdown do not retain an old rate or footer resources", async () => {
  vi.useFakeTimers();
  const state = await setup();
  state.manager.appendMessage(response());
  const old = state.mount();
  assert.equal(old.text(), "42.5 tok/s ");
  await state.emit("session_shutdown", state.context);
  const replacementManager = state.SessionManager.inMemory("/workspace");
  const replacement = state.createContext(replacementManager);
  await state.emit("session_start", replacement);
  const current = state.mount(replacement);
  assert.equal(current.text(), "");
  state.manager.appendMessage(response(1000, 1));
  await state.emit("turn_end", state.context);
  assert.equal(current.text(), "");
  replacementManager.appendMessage(response(120, 2000));
  await state.emit("turn_end", replacement);
  assert.equal(current.text(), "60.0 tok/s ");
  await state.emit("session_shutdown", replacement);
  await state.emit("session_shutdown", replacement);
  assert.equal(old.unsubscribe.mock.calls.length, 1);
  assert.equal(current.unsubscribe.mock.calls.length, 1);
  assert.equal(replacement.footer, undefined);
  assert.equal(vi.getTimerCount(), 0);
});

test("tokens_per_second stays within zero and narrow terminal widths", async () => {
  const state = await setup();
  state.manager.appendMessage(response());
  const { component } = state.mount();
  assert.deepEqual(component.render(0), []);
  for (let width = 1; width <= 20; width += 1) {
    for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});

test.each(["print", "json", "rpc"] as const)(
  "tokens_per_second installs no terminal footer in %s mode",
  async (mode) => {
    const state = await setup(mode);
    state.manager.appendMessage(response());
    await state.emit("turn_end", state.context);
    await state.emit("agent_end", state.context);
    assert.equal(state.context.footer, undefined);
    assert.equal(state.exec.mock.calls.length, 0);
    assert.deepEqual(state.context.notifications, []);
  },
);
