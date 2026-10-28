import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  createEditTool,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { test, vi } from "vitest";
import { createSettingsChatTranscript } from "../src/settings-chat-transcript.js";
import { response } from "./settings-chat-support.js";

initTheme("dark", false);
const width = 80;
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(cwd = "/private-settings-draft", initialExpanded?: boolean) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const state: { messages: AgentMessage[]; streamingMessage?: AgentMessage } = { messages: [] };
  const agent = {
    state,
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Agent;
  const requestRender = vi.fn();
  const tui = { terminal: { rows: 24, columns: width }, requestRender } as unknown as TUI;
  const transcript =
    initialExpanded === undefined
      ? createSettingsChatTranscript(agent, tui, cwd, undefined, join(cwd, "draft.toml"))
      : createSettingsChatTranscript(agent, tui, cwd, initialExpanded, join(cwd, "draft.toml"));
  const definitions = {
    read: createReadToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
  };
  return {
    state,
    tui,
    transcript,
    requestRender,
    listeners,
    emit(event: AgentEvent) {
      // Agent publishes its current state before notifying subscribers.
      if (event.type === "message_start" || event.type === "message_update") {
        state.streamingMessage = event.message;
      } else if (event.type === "message_end") {
        state.messages.push(event.message);
        state.streamingMessage = undefined;
      }
      for (const listener of listeners) listener(event);
    },
    native(call: ToolCall, expanded = initialExpanded ?? false) {
      const component = new ToolExecutionComponent(
        call.name,
        call.id,
        call.arguments,
        { showImages: false, outputPad: 1 },
        definitions[call.name as keyof typeof definitions],
        tui,
        cwd,
      );
      component.setExpanded(expanded);
      return component;
    },
  };
}

function update(f: ReturnType<typeof fixture>, message: AssistantMessage) {
  f.emit({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
  });
}

function compare(
  f: ReturnType<typeof fixture>,
  message: AssistantMessage,
  tools: ToolExecutionComponent[],
  streaming: boolean,
) {
  const assistant = new AssistantMessageComponent(undefined, true);
  assistant.updateContent(message, streaming);
  const expected = [...assistant.render(width), ...tools.flatMap((tool) => tool.render(width))];
  assert.deepEqual(f.transcript.render(width), expected);
  assert.deepEqual(f.transcript.render(width), expected, "a second render must not duplicate tool rows");
  return expected;
}

// InteractiveMode's main-thread branches are the oracle: eager args on message_update,
// argsComplete on successful message_end, start, partialResult, and final result/duration.
for (const name of ["read", "write"] as const) {
  for (const initialExpanded of [undefined, true]) {
    test(`${name} matches native event frames with initialExpanded=${String(initialExpanded)}`, async () => {
      const f = fixture(undefined, initialExpanded);
      const base = await response([], "toolUse").result();
      const call: ToolCall = { type: "toolCall", id: "call-1", name, arguments: {} };
      let message = { ...base, content: [call] };
      try {
        f.emit({ type: "message_start", message: { ...base, content: [] } });
        update(f, message);
        const native = f.native(call);
        compare(f, message, [native], true);

        const args: ToolCall["arguments"] =
          name === "read" ? { path: "draft.toml", offset: 2, limit: 20 } : { path: "draft.toml", content: "draft\n" };
        const completeCall = { ...call, arguments: args };
        message = { ...base, content: [completeCall] };
        update(f, message);
        native.updateArgs(args);
        compare(f, message, [native], true);
        f.emit({ type: "message_end", message });
        native.setArgsComplete();
        compare(f, message, [native], false);

        f.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: name, args });
        native.markExecutionStarted();
        compare(f, message, [native], false);
        const progress = textResult("first partial line\nsecond partial line");
        f.emit({ type: "tool_execution_update", toolCallId: call.id, toolName: name, args, partialResult: progress });
        native.updateResult({ ...progress, isError: false }, true);
        const partialFrame = compare(f, message, [native], false);
        // Native read hides output while collapsed, including partial output.
        if (name === "read" && initialExpanded) assert.match(plain(partialFrame), /first partial line/u);
        f.transcript.invalidate();
        compare(f, message, [native], false);

        const result = textResult(Array.from({ length: 30 }, (_, index) => `result-${index}`).join("\n"));
        f.emit({
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: name,
          result,
          isError: false,
          durationMs: 1250,
        });
        native.updateResult({ ...result, isError: false, durationMs: 1250 });
        const finalFrame = compare(f, message, [native], false);
        assert.notDeepEqual(finalFrame, partialFrame);
        f.emit({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: name,
            ...result,
            isError: false,
            durationMs: 1250,
            timestamp: 2,
          },
        });
        compare(f, message, [native], false);
        f.transcript.invalidate();
        compare(f, message, [native], false);

        const expanded = !(initialExpanded ?? false);
        assert.equal(f.transcript.toggleTools(), expanded);
        native.setExpanded(expanded);
        compare(f, message, [native], false);
        assert.equal(f.transcript.toggleTools(), !expanded);
      } finally {
        f.transcript.dispose();
      }
    });
  }
}

test("multiple calls retain native order across updates, out-of-order results, and history", async () => {
  const f = fixture();
  const base = await response([], "toolUse").result();
  const first: ToolCall = { type: "toolCall", id: "first", name: "read", arguments: { path: "first.toml" } };
  const second: ToolCall = {
    type: "toolCall",
    id: "second",
    name: "write",
    arguments: { path: "second.toml", content: "second" },
  };
  const message = { ...base, content: [first, second] };
  try {
    f.emit({ type: "message_start", message: { ...base, content: [] } });
    update(f, { ...base, content: [first] });
    const a = f.native(first);
    compare(f, { ...base, content: [first] }, [a], true);
    update(f, message);
    const b = f.native(second);
    compare(f, message, [a, b], true);
    f.emit({ type: "message_end", message });
    for (const component of [a, b]) component.setArgsComplete();
    compare(f, message, [a, b], false);
    for (const [call, native] of [
      [second, b],
      [first, a],
    ] as const) {
      f.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
      native.markExecutionStarted();
      compare(f, message, [a, b], false);
      const result = textResult(`${call.id} output`);
      f.emit({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result,
        isError: false,
        durationMs: 25,
      });
      native.updateResult({ ...result, isError: false, durationMs: 25 });
      compare(f, message, [a, b], false);
      f.emit({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          ...result,
          isError: false,
          durationMs: 25,
          timestamp: 3,
        },
      });
      compare(f, message, [a, b], false);
    }
    const expected = f.transcript.render(width);
    f.transcript.dispose();
    const restored = createSettingsChatTranscript(
      { state: f.state, subscribe: () => () => {} } as unknown as Agent,
      f.tui,
      "/private-settings-draft",
    );
    try {
      assert.deepEqual(restored.render(width), expected);
      restored.invalidate();
      assert.deepEqual(restored.render(width), expected);
    } finally {
      restored.dispose();
    }
  } finally {
    f.transcript.dispose();
  }
});

for (const stopReason of ["aborted", "error"] as const) {
  test(`${stopReason} settles all pending native tool calls and survives invalidation`, async () => {
    const f = fixture();
    const base = await response([], "toolUse").result();
    const calls: ToolCall[] = ["a", "b"].map((id) => ({
      type: "toolCall",
      id,
      name: "read",
      arguments: { path: `${id}.toml` },
    }));
    const partial = { ...base, content: calls };
    try {
      f.emit({ type: "message_start", message: { ...base, content: [] } });
      update(f, partial);
      const native = calls.map((call) => f.native(call));
      compare(f, partial, native, true);
      const errorMessage = stopReason === "aborted" ? "Operation aborted" : "provider failed";
      const message = { ...partial, stopReason, errorMessage };
      f.emit({ type: "message_end", message });
      for (const tool of native) tool.updateResult({ ...textResult(errorMessage), isError: true });
      const expected = compare(f, message, native, false);
      assert.match(plain(expected), new RegExp(errorMessage, "u"));
      f.transcript.invalidate();
      compare(f, message, native, false);
      f.emit({ type: "agent_end", messages: f.state.messages });
      compare(f, message, native, false);
    } finally {
      f.transcript.dispose();
    }
  });
}

test("execution errors use native final output instead of pending progress", async () => {
  const f = fixture();
  const call: ToolCall = { type: "toolCall", id: "failure", name: "read", arguments: { path: "missing.toml" } };
  const message = await response([call], "toolUse").result();
  try {
    f.emit({ type: "message_start", message: { ...message, content: [] } });
    update(f, message);
    const native = f.native(call);
    f.emit({ type: "message_end", message });
    native.setArgsComplete();
    f.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    native.markExecutionStarted();
    const result = textResult("ENOENT: missing.toml");
    f.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: true,
      durationMs: 42,
    });
    native.updateResult({ ...result, isError: true, durationMs: 42 });
    compare(f, message, [native], false);
    f.transcript.invalidate();
    compare(f, message, [native], false);
  } finally {
    f.transcript.dispose();
  }
});

test("tool display is sanitized without changing event arguments, results, or history", async () => {
  const f = fixture();
  const control = "\u001b]52;c;payload\u0007\u001b[2J";
  const call: ToolCall = { type: "toolCall", id: "safe-id", name: "read", arguments: { path: `draft${control}.toml` } };
  const message = await response([call], "toolUse").result();
  const result = textResult(`before${control}after`);
  const original = structuredClone({ message, result });
  try {
    f.emit({ type: "message_start", message: { ...message, content: [] } });
    update(f, message);
    const safeCall = { ...call, arguments: { path: sanitizeTerminalDocument(String(call.arguments.path)) } };
    const native = f.native(safeCall);
    compare(f, { ...message, content: [safeCall] }, [native], true);
    f.emit({ type: "message_end", message });
    native.setArgsComplete();
    f.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    native.markExecutionStarted();
    f.emit({
      type: "tool_execution_update",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
      partialResult: result,
    });
    native.updateResult({ ...textResult(sanitizeTerminalDocument(result.content[0].text)), isError: false }, true);
    compare(f, { ...message, content: [safeCall] }, [native], false);
    f.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError: false });
    native.updateResult({ ...textResult(sanitizeTerminalDocument(result.content[0].text)), isError: false });
    const frame = compare(f, { ...message, content: [safeCall] }, [native], false);
    assert.ok(!frame.join("\n").includes(control));
    assert.deepEqual({ message, result }, original);
    assert.deepEqual(f.state.messages[0], original.message);
  } finally {
    f.transcript.dispose();
  }
});

test("edit reads only complete arguments, previews before mutation, and uses final details.diff", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "starship-tool-preview-"));
  const path = join(cwd, "draft.toml");
  await fs.writeFile(path, "before\n");
  const f = fixture(cwd);
  const readFile = vi.spyOn(fs, "readFile");
  const access = vi.spyOn(fs, "access");
  syncBuiltinESMExports();
  const call: ToolCall = {
    type: "toolCall",
    id: "edit-1",
    name: "edit",
    arguments: { path, edits: [{ oldText: "before", newText: "after" }] },
  };
  const message = await response([call], "toolUse").result();
  try {
    f.emit({ type: "message_start", message: { ...message, content: [] } });
    update(f, message);
    const native = f.native(call);
    compare(f, message, [native], true);
    f.transcript.invalidate();
    compare(f, message, [native], true);
    assert.equal(access.mock.calls.length, 0, "streamed arguments must not start a native preview");
    assert.equal(readFile.mock.calls.length, 0, "even structurally complete streamed arguments must not read a file");
    f.emit({ type: "message_end", message });
    native.setArgsComplete();
    await vi.waitFor(() => {
      assert.match(plain(f.transcript.render(width)), /-1 before/u);
      assert.match(plain(native.render(width)), /\+1 after/u);
    });
    compare(f, message, [native], false);
    assert.equal(await fs.readFile(path, "utf8"), "before\n");
    f.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    native.markExecutionStarted();
    compare(f, message, [native], false);
    const result = await createEditTool(cwd).execute(call.id, {
      path,
      edits: [{ oldText: "before", newText: "after" }],
    });
    assert.equal(await fs.readFile(path, "utf8"), "after\n");
    assert.match(result.details?.diff ?? "", /\+1 after/u);
    // A later disk change must not replace the authoritative result diff.
    await fs.writeFile(path, "unrelated later content\n");
    f.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: false,
      durationMs: 12,
    });
    native.updateResult({ ...result, isError: false, durationMs: 12 });
    compare(f, message, [native], false);
    const accesses = access.mock.calls.length;
    f.transcript.invalidate();
    const final = compare(f, message, [native], false);
    assert.equal(access.mock.calls.length, accesses, "final result rebuilds must not start another preview");
    assert.match(plain(final), /\+1 after/u);
    assert.doesNotMatch(plain(final), /unrelated later content/u);
  } finally {
    readFile.mockRestore();
    access.mockRestore();
    syncBuiltinESMExports();
    f.transcript.dispose();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

for (const target of ["outside.toml", "../outside.toml", "/outside.toml"]) {
  test(`edit preview does not read a target outside the owned draft: ${target}`, async () => {
    const f = fixture();
    const access = vi.spyOn(fs, "access");
    const readFile = vi.spyOn(fs, "readFile");
    syncBuiltinESMExports();
    try {
      const call: ToolCall = {
        type: "toolCall",
        id: "denied",
        name: "edit",
        arguments: { path: target, edits: [{ oldText: "before", newText: "after" }] },
      };
      const message = await response([call], "toolUse").result();
      update(f, message);
      f.emit({ type: "message_end", message });
      f.transcript.render(width);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(access.mock.calls.length, 0);
      assert.equal(readFile.mock.calls.length, 0);
      f.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
      f.emit({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result: textResult("Only the owned draft is editable"),
        isError: true,
      });
      assert.match(plain(f.transcript.render(width)), /Only the owned draft is editable/u);
      assert.equal(access.mock.calls.length, 0);
      assert.equal(readFile.mock.calls.length, 0);
    } finally {
      f.transcript.dispose();
      access.mockRestore();
      readFile.mockRestore();
      syncBuiltinESMExports();
    }
  });
}

for (const filePathAlias of [false, true]) {
  test(`relative owned edit path supports native preview; file_path alias=${filePathAlias}`, async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "starship-relative-preview-"));
    await fs.writeFile(join(cwd, "draft.toml"), "before\n");
    const f = fixture(cwd);
    try {
      const call: ToolCall = {
        type: "toolCall",
        id: "relative",
        name: "edit",
        arguments: {
          ...(filePathAlias ? { file_path: "./draft.toml" } : { path: "./draft.toml" }),
          edits: [{ oldText: "before", newText: "after" }],
        },
      };
      const message = await response([call], "toolUse").result();
      // A complete provider message can arrive without any incremental update.
      f.emit({ type: "message_end", message });
      await vi.waitFor(() => assert.match(plain(f.transcript.render(width)), /\+1 after/u));
    } finally {
      f.transcript.dispose();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

test("a native edit preview that finishes after disposal cannot request a render", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "starship-late-preview-"));
  const path = join(cwd, "draft.toml");
  await fs.writeFile(path, "before\n");
  const f = fixture(cwd);
  const entered = deferred<void>();
  const release = deferred<void>();
  const settled = deferred<void>();
  const originalRead = fs.readFile;
  const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === path) {
      entered.resolve();
      await release.promise;
    }
    try {
      return await originalRead(...args);
    } finally {
      settled.resolve();
    }
  });
  syncBuiltinESMExports();
  try {
    const call: ToolCall = {
      type: "toolCall",
      id: "late-edit",
      name: "edit",
      arguments: { path, edits: [{ oldText: "before", newText: "after" }] },
    };
    const message = await response([call], "toolUse").result();
    f.emit({ type: "message_start", message: { ...message, content: [] } });
    update(f, message);
    f.emit({ type: "message_end", message });
    // No render is needed to begin the native preview.
    await vi.waitFor(() => assert.ok(readFile.mock.calls.some(([file]) => String(file) === path)));
    await entered.promise;
    f.transcript.dispose();
    f.transcript.dispose();
    assert.equal(f.listeners.size, 0);
    const renders = f.requestRender.mock.calls.length;
    release.resolve();
    await settled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.requestRender.mock.calls.length, renders);
    assert.deepEqual(f.transcript.render(width), []);
  } finally {
    release.resolve();
    readFile.mockRestore();
    syncBuiltinESMExports();
    f.transcript.dispose();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
