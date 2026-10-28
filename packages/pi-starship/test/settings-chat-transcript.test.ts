import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  createReadToolDefinition,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createSettingsChatTranscript } from "../src/settings-chat-transcript.js";
import { response, testModel } from "./settings-chat-support.js";

initTheme("dark", false);
const cwd = "/private-settings-draft";
function fixture(messages: AgentMessage[], expanded = true) {
  const agent = new Agent({
    initialState: { model: { ...testModel, input: ["text"] }, messages },
    streamFn: () => response([]),
  });
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as TUI;
  return { agent, tui, transcript: createSettingsChatTranscript(agent, tui, cwd, expanded) };
}

test("user and assistant blocks exactly reuse native Markdown, backgrounds, padding, and later-question spacing", async () => {
  const question = "Show **model** in red. 中文 🙂";
  const reply = "Updated the draft.\n\n```toml\n[model]\nstyle = 'red'\n```";
  const next = "Keep the directory too.";
  const assistant = await response([{ type: "text", text: reply }]).result();
  const messages: AgentMessage[] = [
    { role: "user", content: question, timestamp: 1 },
    assistant,
    { role: "user", content: next, timestamp: 2 },
  ];
  const f = fixture(messages);
  try {
    const expected = [
      ...new UserMessageComponent(question).render(80),
      ...new AssistantMessageComponent(assistant, true).render(80),
      "",
      ...new UserMessageComponent(next).render(80),
    ];
    assert.deepEqual(f.transcript.render(80), expected);
    assert.deepEqual(f.transcript.render(80), expected);
    assert.doesNotMatch(expected.join("\n"), /You:|Agent:/u);
    assert.deepEqual(f.transcript.render(0), []);
    initTheme("light", false);
    f.transcript.invalidate();
    assert.deepEqual(f.transcript.render(80), [
      ...new UserMessageComponent(question).render(80),
      ...new AssistantMessageComponent(assistant, true).render(80),
      "",
      ...new UserMessageComponent(next).render(80),
    ]);
  } finally {
    f.transcript.dispose();
    initTheme("dark", false);
  }
});

test("message anchors retain exact rows through eviction and invalidation", () => {
  const f = fixture(
    Array.from({ length: 30 }, (_, index) => ({
      role: "user" as const,
      content: Array.from({ length: (index % 5) + 1 }, (_, row) => `message-${index}-row-${row}`).join("\n"),
      timestamp: index,
    })),
  );
  try {
    const before = f.transcript.render(80);
    const anchors = before.map((line, row) => ({ line, anchor: f.transcript.anchorAt(row) }));
    f.agent.state.messages.push({ role: "user", content: "new message", timestamp: 30 });
    f.transcript.invalidate();
    const after = f.transcript.render(80);
    for (const { line, anchor } of anchors) {
      assert.ok(anchor);
      if (anchor.message === f.agent.state.messages[0]) assert.equal(f.transcript.rowAt(anchor), 0);
      else if (anchor.row >= 0) assert.equal(after[f.transcript.rowAt(anchor)], line);
    }
    f.transcript.dispose();
    assert.equal(f.transcript.anchorAt(0), undefined);
  } finally {
    f.transcript.dispose();
  }
});

for (const [beforeWidth, afterWidth] of [
  [80, 35],
  [35, 100],
]) {
  test(`message anchors retain the first visible content across ${beforeWidth} to ${afterWidth} reflow`, () => {
    const content = Array.from({ length: 100 }, (_, index) => `word-${index}`).join(" ");
    const f = fixture([{ role: "user", content, timestamp: 0 }]);
    try {
      const before = f.transcript.render(beforeWidth);
      const row = before.findIndex((line) => stripVTControlCharacters(line).includes("word-42"));
      const firstWord = stripVTControlCharacters(before[row]).trim().split(/\s/u)[0];
      const anchor = f.transcript.anchorAt(row);
      assert.ok(anchor);
      const after = f.transcript.render(afterWidth);
      assert.ok(stripVTControlCharacters(after[f.transcript.rowAt(anchor)]).includes(firstWord));
    } finally {
      f.transcript.dispose();
    }
  });
}

for (const [beforeWidth, afterWidth] of [
  [80, 35],
  [35, 100],
]) {
  test(`Markdown decoration does not shift content anchors across ${beforeWidth} to ${afterWidth} reflow`, async () => {
    const text =
      "# Heading\n\n" +
      "first paragraph words ".repeat(30) +
      "\n\n---\n\n" +
      Array.from({ length: 100 }, (_, index) => `word-${index}`).join(" ");
    const message = await response([{ type: "text", text }]).result();
    const f = fixture([message]);
    try {
      const before = f.transcript.render(beforeWidth);
      const row = before.findIndex((line) => stripVTControlCharacters(line).includes("word-42"));
      const firstWord = stripVTControlCharacters(before[row]).trim().split(/\s/u)[0];
      const anchor = f.transcript.anchorAt(row);
      assert.ok(anchor);
      const after = f.transcript.render(afterWidth);
      assert.ok(stripVTControlCharacters(after[f.transcript.rowAt(anchor)]).includes(firstWord));
    } finally {
      f.transcript.dispose();
    }
  });
}

test("tool collapse retains a later tool heading within the same assistant message", async () => {
  const calls = ["first-file", "second-file"].map((path) => ({
    type: "toolCall" as const,
    id: path,
    name: "read",
    arguments: { path },
  }));
  const assistant = await response(calls, "toolUse").result();
  const f = fixture([
    assistant,
    ...calls.map((call) => ({
      role: "toolResult" as const,
      toolCallId: call.id,
      toolName: "read",
      content: [{ type: "text" as const, text: "output\n".repeat(60) }],
      isError: false,
      timestamp: 0,
    })),
  ]);
  try {
    const before = f.transcript.render(80);
    const row = before.findIndex((line) => stripVTControlCharacters(line).includes("second-file"));
    const anchor = f.transcript.anchorAt(row);
    assert.ok(anchor);
    f.transcript.toggleTools();
    const collapsed = f.transcript.render(80);
    assert.equal(
      f.transcript.rowAt(anchor),
      collapsed.findIndex((line) => stripVTControlCharacters(line).includes("second-file")),
    );
    f.transcript.toggleTools();
    f.transcript.render(80);
    assert.equal(f.transcript.rowAt(anchor), row);
  } finally {
    f.transcript.dispose();
  }
});

for (const isError of [false, true]) {
  test(`tool ${isError ? "error" : "success"} uses native tool framing without changing raw arguments or results`, async () => {
    const unsafe = "\x1b]52;c;secret\x07";
    const assistant = await response(
      [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: `${cwd}/${unsafe}pi-starship.toml` } }],
      "toolUse",
    ).result();
    const result = {
      role: "toolResult" as const,
      toolCallId: "read-call",
      toolName: "read",
      content: [{ type: "text" as const, text: `draft${unsafe}` }],
      isError,
      timestamp: 2,
    };
    const f = fixture([assistant, result]);
    const original = JSON.stringify(f.agent.state.messages);
    try {
      const native = new ToolExecutionComponent(
        "read",
        "read-call",
        { path: `${cwd}/pi-starship.toml` },
        { showImages: false, outputPad: 1 },
        createReadToolDefinition(cwd),
        f.tui,
        cwd,
      );
      native.setExpanded(true);
      native.setArgsComplete();
      native.markExecutionStarted();
      native.updateResult({ content: [{ type: "text", text: "draft" }], isError });
      const actual = f.transcript.render(80);
      assert.deepEqual(actual, native.render(80));
      assert.ok(!actual.join("\n").includes("\x1b]52"));
      assert.doesNotMatch(actual.join("\n"), /to expand/u);
      f.transcript.toggleTools();
      native.setExpanded(false);
      assert.deepEqual(f.transcript.render(80), native.render(80));
      f.transcript.invalidate();
      assert.deepEqual(f.transcript.render(80), native.render(80));
      f.transcript.toggleTools();
      native.setExpanded(true);
      assert.deepEqual(f.transcript.render(80), native.render(80));
      assert.equal(JSON.stringify(f.agent.state.messages), original);
    } finally {
      f.transcript.dispose();
    }
  });
}

test("unknown tool names, IDs, paths, and results are sanitized before native fallback rendering", async () => {
  const unsafe = "\x1b]52;c;secret\x07";
  const assistant = await response(
    [
      {
        type: "toolCall",
        id: `id${unsafe}`,
        name: `unknown${unsafe}`,
        arguments: { path: `${cwd}/${unsafe}draft.toml` },
      },
    ],
    "toolUse",
  ).result();
  const result = {
    role: "toolResult" as const,
    toolCallId: `id${unsafe}`,
    toolName: `unknown${unsafe}`,
    content: [{ type: "text" as const, text: `Rejected${unsafe}` }],
    isError: true,
    timestamp: 2,
  };
  const f = fixture([assistant, result]);
  const raw = JSON.stringify(f.agent.state.messages);
  try {
    const frame = f.transcript.render(80).join("\n");
    assert.ok(!frame.includes("\x1b]52"));
    assert.match(frame, /unknown/u);
    assert.match(frame, /Rejected/u);
    assert.equal(JSON.stringify(f.agent.state.messages), raw);
  } finally {
    f.transcript.dispose();
  }
});

test("streaming replies use the native assistant block and become one finalized message", async () => {
  const stream = createAssistantMessageEventStream();
  const partial = await response([{ type: "text", text: "Live **reply** 中文" }]).result();
  const agent = new Agent({ initialState: { model: { ...testModel, input: ["text"] } }, streamFn: () => stream });
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as TUI;
  const transcript = createSettingsChatTranscript(agent, tui, cwd);
  let ready!: () => void;
  const updated = new Promise<void>((done) => {
    ready = done;
  });
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update") ready();
  });
  const running = agent.prompt("Streaming question");
  try {
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Live **reply** 中文", partial });
    await updated;
    const native = new AssistantMessageComponent(undefined, true);
    native.updateContent(partial, true);
    assert.deepEqual(transcript.render(80), [
      ...new UserMessageComponent("Streaming question").render(80),
      ...native.render(80),
    ]);
    stream.push({ type: "done", reason: "stop", message: partial });
    await running;
    assert.deepEqual(transcript.render(80), [
      ...new UserMessageComponent("Streaming question").render(80),
      ...new AssistantMessageComponent(partial, true).render(80),
    ]);
  } finally {
    stream.end(partial);
    await running;
    unsubscribe();
    transcript.dispose();
    assert.deepEqual(transcript.render(80), []);
  }
});

for (const reason of ["stop", "error", "aborted"] as const) {
  test(`streaming anchors survive object replacement, invalidation, and ${reason} finalization`, async () => {
    let stream = createAssistantMessageEventStream();
    const agent = new Agent({ initialState: { model: { ...testModel, input: ["text"] } }, streamFn: () => stream });
    const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as TUI;
    let transcript = createSettingsChatTranscript(agent, tui, cwd);
    const text = Array.from({ length: 120 }, (_, row) => `stream-row-${row}`).join("\n");
    const partial = await response([{ type: "text", text }]).result();
    const update = async (message: typeof partial) => {
      let unsubscribe = () => {};
      const updated = new Promise<void>((done) => {
        unsubscribe = agent.subscribe((event) => {
          if (event.type === "message_update") done();
        });
      });
      try {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "more", partial: message });
        await updated;
      } finally {
        unsubscribe();
      }
    };
    let running = agent.prompt("Streaming question");
    try {
      stream.push({ type: "start", partial });
      await update(partial);
      if (reason === "error") {
        // A transcript can also be attached after a response has started.
        transcript.dispose();
        transcript = createSettingsChatTranscript(agent, tui, cwd);
      }
      const first = agent.state.streamingMessage;
      const lines = transcript.render(80);
      const row = lines.findIndex((line) => line.includes("stream-row-54"));
      assert.ok(row > 0);
      const anchor = transcript.anchorAt(row);
      assert.ok(anchor);
      const next = { ...partial, content: [{ type: "text" as const, text: `${text}\nnew tail` }] };
      await update(next);
      assert.notEqual(agent.state.streamingMessage, first);
      transcript.invalidate();
      const updated = transcript.render(80);
      assert.equal(transcript.rowAt(anchor), row);
      assert.equal(updated[transcript.rowAt(anchor)], lines[row]);
      // Finalization can arrive with no render of the last partial object.
      await update({ ...next });
      const final = { ...next, stopReason: reason };
      stream.push(
        reason === "stop" ? { type: "done", reason, message: final } : { type: "error", reason, error: final },
      );
      await running;
      const finalized = transcript.render(80);
      assert.equal(transcript.rowAt(anchor), row);
      assert.equal(finalized[transcript.rowAt(anchor)], lines[row]);
      if (reason === "stop") {
        // A later response must not reuse this identity, even with the same timestamp.
        stream = createAssistantMessageEventStream();
        running = agent.prompt("Next response");
        stream.push({ type: "start", partial });
        await update(partial);
        const secondLines = transcript.render(80);
        const secondAnchor = transcript.anchorAt(secondLines.length - 5);
        assert.ok(secondAnchor);
        assert.notEqual(secondAnchor.message, anchor.message);
        stream.push({ type: "done", reason: "stop", message: { ...partial } });
        await running;
      }
    } finally {
      stream.end(partial);
      await running;
      transcript.dispose();
      transcript.dispose();
    }
  });
}

test("transcript disposal releases its identity listener once", () => {
  const agent = new Agent({
    initialState: { model: { ...testModel, input: ["text"] } },
    streamFn: () => response([]),
  });
  const subscribe = agent.subscribe.bind(agent);
  let active = 0;
  agent.subscribe = (listener) => {
    active += 1;
    const unsubscribe = subscribe(listener);
    return () => {
      active -= 1;
      unsubscribe();
    };
  };
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as TUI;
  const transcript = createSettingsChatTranscript(agent, tui, cwd);
  assert.equal(active, 1);
  transcript.invalidate();
  assert.equal(active, 1);
  transcript.dispose();
  transcript.dispose();
  assert.equal(active, 0);
});

test("native error-only assistant messages retain error styling and sanitized display payloads", async () => {
  const message = await response([]).result();
  message.stopReason = "error";
  message.errorMessage = "Failed\x1b[2J";
  const f = fixture([message]);
  try {
    assert.deepEqual(
      f.transcript.render(80),
      new AssistantMessageComponent({ ...message, errorMessage: "Failed" }, true).render(80),
    );
    assert.equal(message.errorMessage, "Failed\x1b[2J");
  } finally {
    f.transcript.dispose();
  }
});
