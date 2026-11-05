import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorComponent, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { F2, PLAN, DISCUSSION_QUESTIONS as questions, withDiscussion } from "./discussion-support.js";
import { createMockContext } from "./support.js";
import { renderMockWidget } from "./widget-support.js";

test("idle F2 switches only interaction mode, preserves the main draft and tool envelope, and sends no turn", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    const tools = f.mock.rawPi.getActiveTools();
    assert.ok(f.mock.shortcuts.has("f2"));
    const before = f.mock.sentUserMessages.length;
    await f.dispatch(F2);
    assert.equal(f.state().enabled, true);
    assert.equal(f.state().interactionMode, "discussion");
    assert.equal(f.context.editorText, "main draft stays here");
    assert.deepEqual(f.mock.rawPi.getActiveTools(), tools);
    assert.match(f.context.statuses.get("plan-mode") ?? "", /discussion/u);
    assert.equal(f.mock.sentUserMessages.length, before);
    assert.equal(f.tui.openCount, 0);
    await f.dispatch(F2);
    assert.equal(f.state().interactionMode, "questions");
    assert.equal(f.mock.sentUserMessages.length, before);
    assert.equal(f.tui.openCount, 0, "resuming must not replay old questions");
    assert.ok(f.mock.sentMessages.every((entry) => (entry.options as { triggerTurn?: boolean }).triggerTurn === false));
  });
});

test("F2 does not change inactive Plan mode or interrupt unrelated running work", async () => {
  await withDiscussion(async (f) => {
    const initialEntries = f.mock.entries.length;
    await f.dispatch(F2);
    assert.equal(f.mock.entries.length, initialEntries);
    await f.command("start");
    f.setIdle(false);
    await f.dispatch(F2);
    assert.equal(f.state().interactionMode, "questions");
    assert.equal(f.aborts, 0);
    assert.match(f.context.notifications.at(-1)?.message ?? "", /settle/u);
  });
});

for (const mode of ["tui", "rpc", "print", "json"] as const) {
  test(`discussion question calls return questions_paused with no UI in ${mode}`, async () => {
    const branch = [
      {
        type: "custom",
        customType: "plan-mode-state",
        data: { enabled: true, awaitingAction: false, interactionMode: "discussion" },
      },
    ];
    await withDiscussion(
      async (f) => {
        const result = await f.execute("plan_mode_question", "paused", { questions });
        assert.equal(result.details.reason, "questions_paused");
        assert.equal(result.details.cancelled, true);
        assert.equal(result.details.answers, undefined);
        assert.equal(result.terminate, undefined);
        assert.match(result.content[0]?.text ?? "", /plain text/u);
        assert.equal(f.tui.openCount, 0);
        assert.equal(f.listeners.size, mode === "tui" ? 1 : 0);
        assert.equal(f.aborts, 0);
      },
      { mode, branch },
    );
  });
}

for (const page of ["options", "review", "custom answer", "note"] as const) {
  test(`F2 in questionnaire ${page} discards every unsubmitted answer and releases input ownership`, async () => {
    await withDiscussion(async (f) => {
      await f.command("start");
      f.setIdle(false);
      const running = f.execute("plan_mode_question", "question", { questions });
      await f.tui.waitForOpen();
      f.tui.setFocused(true);
      assert.equal(f.listeners.size, 2);
      if (page === "review") {
        await f.dispatch("\r");
        await f.dispatch("\r");
        assert.match(f.tui.render().join("\n"), /Review answers/u);
      } else if (page === "custom answer") {
        await f.dispatch("\u001b[B");
        await f.dispatch("\u001b[B");
        await f.dispatch("\r");
        await f.dispatch("unsubmitted custom answer");
        assert.match(f.tui.render().join("\n"), /unsubmitted custom answer/u);
      } else if (page === "note") {
        await f.dispatch("n");
        await f.dispatch("unsubmitted note");
        assert.match(f.tui.render().join("\n"), /unsubmitted note/u);
      }
      assert.equal(await f.dispatch(F2), true, "questionnaire listener must consume F2");
      const result = await running;
      assert.equal(result.details.reason, "discussion_requested");
      assert.equal(result.details.cancelled, true);
      assert.equal(result.terminate, true);
      assert.equal(result.details.answers, undefined);
      assert.equal(f.tui.isOpen, false);
      assert.equal(f.listeners.size, 1);
      assert.equal(f.context.editorText, "main draft stays here");
      assert.equal(f.mock.sentUserMessages.length, 0);
      assert.equal(f.aborts, 0, "abort must wait for the matching execution-end event");
      await f.emit("tool_execution_end", { toolCallId: "question", toolName: "plan_mode_question" });
      assert.equal(f.aborts, 1);
      await f.dispatch(" next independent input");
      assert.equal(f.context.editorText, "main draft stays here next independent input");
      f.setIdle(true);
      await f.dispatch(F2);
      await f.emit("agent_settled");
      assert.equal(f.state().interactionMode, "questions");
      assert.equal(f.tui.openCount, 1);
    });
  });
}

for (const callId of ["standalone", "parallel:question:2", "outer:child:question/3"]) {
  test(`only the matching execution-end aborts once for ${callId}`, async () => {
    await withDiscussion(async (f) => {
      await f.command("start");
      f.setIdle(false);
      const running = f.execute("plan_mode_question", callId, { questions });
      await f.tui.waitForOpen();
      await f.dispatch(F2);
      assert.equal((await running).terminate, true);
      await f.emit("tool_execution_end", { toolCallId: "sibling-read", toolName: "read" });
      assert.equal(f.aborts, 0);
      await f.emit("tool_execution_end", { toolCallId: callId, toolName: "plan_mode_question" });
      await f.emit("tool_execution_end", { toolCallId: callId, toolName: "plan_mode_question" });
      await f.emit("tool_execution_end", { toolCallId: "outer", toolName: "parallel" });
      assert.equal(f.aborts, 1);
    });
  });
}

for (const reset of ["tree", "session", "workflow"] as const) {
  test(`stale question listener and execution-end cannot affect a new ${reset} generation`, async () => {
    await withDiscussion(async (f) => {
      await f.command("start");
      const running = f.execute("plan_mode_question", "old-call", { questions });
      await f.tui.waitForOpen();
      const staleListener = f.capturedListeners.at(-1);
      assert.ok(staleListener);
      await f.dispatch(F2);
      await running;
      if (reset === "tree") {
        f.branch.splice(0, f.branch.length, {
          type: "custom",
          customType: "plan-mode-state",
          data: { enabled: true, awaitingAction: false, interactionMode: "questions" },
        });
        await f.emit("session_tree");
      } else if (reset === "session") {
        const next = createMockContext({ mode: "tui", hasUI: true });
        f.replaceContext(next);
        await f.emit("session_start", { reason: "new" });
        await f.command("start");
      } else {
        await f.command("off");
        await f.command("start");
      }
      const current = reset === "session" ? undefined : f.execute("plan_mode_question", "new-call", { questions });
      if (current) await f.tui.waitForOpen();
      staleListener(F2);
      await f.emit("tool_execution_end", { toolCallId: "old-call", toolName: "plan_mode_question" });
      assert.equal(f.aborts, 0);
      assert.equal(f.state().interactionMode, "questions");
      if (current) {
        assert.equal(f.tui.isOpen, true, "stale callbacks cannot close the new questionnaire");
        f.tui.press("tui.select.cancel");
        assert.equal((await current).details.reason, "cancelled");
      }
    });
  });
}

for (const source of ["structured", "legacy"] as const) {
  test(`${source} completion in discussion persists a ready plan without an automatic menu; manual /plan retains actions`, async () => {
    await withDiscussion(async (f) => {
      await f.command("start");
      await f.dispatch(F2);
      if (source === "structured") {
        await f.execute("plan_mode_complete", "ready", { plan: PLAN });
      } else {
        await f.emit("agent_end", {
          messages: [{ role: "assistant", content: `<proposed_plan>\n${PLAN}\n</proposed_plan>` }],
        });
      }
      await f.emit("agent_settled");
      assert.equal(f.state().awaitingAction, true);
      assert.equal(f.state().latestPlan, PLAN);
      assert.match(f.context.statuses.get("plan-mode") ?? "", /ready/u);
      assert.match(renderMockWidget(f.context.widgets.get("plan-mode-plan")).join("\n"), /discussion/u);
      assert.equal(f.tui.openCount, 0);
      if (source === "legacy") {
        assert.ok(
          f.mock.sentMessages.some((entry) => {
            const message = entry.message as { customType?: string; content?: string; display?: boolean };
            return message.customType === "proposed-plan" && message.display && message.content?.includes(PLAN);
          }),
          "legacy plan must remain visible when the ready menu is suppressed",
        );
      }
      await f.dispatch(F2);
      await f.emit("agent_settled");
      assert.equal(f.tui.openCount, 0, "resuming questionnaires must not resurrect a ready-menu intent");
      const menu = f.command("");
      await f.tui.waitForOpen();
      const frame = f.tui.render().join("\n");
      for (const action of ["Implement here", "Start fresh and implement", "Export plan", "Save for later"])
        assert.ok(frame.includes(action), action);
      f.tui.press("tui.select.cancel");
      await menu;
      assert.equal(f.state().latestPlan, PLAN);
    });
  });
}

test("discussion /plan finalize permits a plain-text question and does not launch a structured retry after resume", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    await f.dispatch(F2);
    await f.command("finalize");
    assert.equal(f.mock.sentUserMessages.length, 1);
    const prompt = f.mock.sentUserMessages[0]?.text ?? "";
    assert.match(prompt, /plain-text question/u);
    assert.match(prompt, /Questionnaires remain paused/u);
    assert.doesNotMatch(prompt, /plan_mode_question/u);
    await f.emit("message_start", { message: { role: "user", content: prompt } });
    await f.emit("agent_end", {
      messages: [{ role: "assistant", content: "Which scope should I use?", stopReason: "stop" }],
    });
    await f.emit("agent_settled");
    await f.dispatch(F2);
    await f.emit("agent_settled");
    assert.equal(f.mock.sentUserMessages.length, 1);
    assert.equal(f.tui.openCount, 0);
  });
});

test("switching to discussion cancels an already pending structured finalization retry", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    await f.command("finalize");
    await f.emit("agent_end", { messages: [{ role: "assistant", content: "Need one decision.", stopReason: "stop" }] });
    await f.dispatch(F2);
    await f.emit("agent_settled");
    await f.dispatch(F2);
    await f.emit("agent_settled");
    assert.equal(f.mock.sentUserMessages.length, 1);
    assert.equal(f.state().interactionMode, "questions");
  });
});

for (const failure of ["persist", "publish"] as const) {
  test(`failed ${failure} rolls back discussion mode and keeps the same unanswered questionnaire usable`, async () => {
    await withDiscussion(async (f) => {
      await f.command("start");
      const running = f.execute("plan_mode_question", "rollback", { questions });
      await f.tui.waitForOpen();
      f.tui.setFocused(true);
      await f.dispatch("n");
      await f.dispatch("keep this note draft");
      const before = f.tui.render();
      const original = failure === "persist" ? f.mock.rawPi.appendEntry : f.mock.rawPi.sendMessage;
      let calls = 0;
      if (failure === "persist")
        f.mock.rawPi.appendEntry = (...args) => {
          if (++calls === 1) throw new Error("persist failed");
          (original as typeof f.mock.rawPi.appendEntry)(...args);
        };
      else
        f.mock.rawPi.sendMessage = (...args) => {
          if (++calls === 1) throw new Error("publish failed");
          (original as typeof f.mock.rawPi.sendMessage)(...args);
        };
      await f.dispatch(F2);
      assert.equal(f.state().interactionMode, "questions");
      assert.equal(f.tui.isOpen, true);
      assert.equal(f.tui.openCount, 1);
      assert.equal(f.listeners.size, 2);
      assert.equal(f.aborts, 0);
      assert.match(f.context.notifications.at(-1)?.message ?? "", /unchanged/u);
      assert.deepEqual(f.tui.render(), before, "rollback must preserve the exact editor and draft");
      await f.dispatch("\r");
      await f.dispatch("\r");
      await f.dispatch("\r");
      await f.dispatch("\r");
      const result = await running;
      assert.equal(result.details.cancelled, false);
      assert.equal(result.details.answers?.length, 2);
      assert.equal((result.details.answers?.[0] as { note?: string } | undefined)?.note, "keep this note draft");
      assert.equal(result.terminate, undefined);
    });
  });
}

test("rollback failure closes the questionnaire, aborts, and blocks new questionnaires until lifecycle reset", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    const running = f.execute("plan_mode_question", "failclosed", { questions });
    await f.tui.waitForOpen();
    const sendMessage = f.mock.rawPi.sendMessage;
    f.mock.rawPi.sendMessage = () => {
      throw new Error("publication unavailable");
    };
    await f.dispatch(F2);
    const result = await running;
    assert.equal(result.details.answers, undefined);
    assert.equal(f.tui.isOpen, false);
    assert.equal(f.aborts, 1);
    assert.match(f.context.notifications.at(-1)?.message ?? "", /blocked.*reload/u);
    assert.equal((await f.execute("plan_mode_question", "blocked", { questions })).details.reason, "questions_paused");
    await f.dispatch(F2);
    assert.equal(f.tui.openCount, 1);
    f.mock.rawPi.sendMessage = sendMessage;
    await f.emit("session_start", { reason: "reload" });
    await f.command("start");
    const next = f.execute("plan_mode_question", "after-reset", { questions });
    await f.tui.waitForOpen();
    f.tui.press("tui.select.cancel");
    assert.equal((await next).details.reason, "cancelled");
  });
});

test("native F2 conflict suppresses registration and hints but /plan can toggle discussion", async () => {
  await withDiscussion(
    async (f) => {
      await f.command("start");
      assert.equal(f.mock.shortcuts.has("f2"), false);
      assert.equal(f.listeners.size, 0);
      const menu = f.command("");
      await f.tui.waitForOpen();
      assert.doesNotMatch(f.tui.render().join("\n"), /F2/u);
      f.tui.press("tui.select.down");
      assert.match(f.tui.render().join("\n"), /Switch to free discussion/u);
      f.tui.press("tui.select.confirm");
      await menu;
      assert.equal(f.state().interactionMode, "discussion");
      assert.equal((await f.execute("plan_mode_question", "paused", { questions })).details.reason, "questions_paused");
    },
    { nativeBindings: true, bindings: { "app.model.select": "f2" } },
  );
});

test("F2 repeat/release events and fragmented bracketed paste cannot switch an active custom-answer editor", async () => {
  await withDiscussion(
    async (f) => {
      setKittyProtocolActive(true);
      await f.command("start");
      const running = f.execute("plan_mode_question", "keys", { questions });
      await f.tui.waitForOpen();
      f.tui.setFocused(true);
      await f.dispatch("\u001b[B");
      await f.dispatch("\u001b[B");
      await f.dispatch("\r");
      for (const event of ["\u001b[12;1:2~", "\u001b[12;1:3~"]) {
        assert.equal(await f.dispatch(event), true, "the raw listener consumes repeat/release events");
        assert.equal(f.state().interactionMode, "questions");
      }
      for (const fragment of ["\u001b[20", "0~", "pasted ", F2, " text", "\u001b[20", "1~"]) await f.dispatch(fragment);
      assert.equal(f.state().interactionMode, "questions");
      assert.equal(f.tui.isOpen, true);
      await f.dispatch("\u007f");
      await f.dispatch("jkn");
      assert.match(f.tui.render().join("\n"), /jkn/u, "page shortcuts must remain ordinary editor text");
      await f.dispatch(F2);
      assert.equal((await running).details.reason, "discussion_requested");
    },
    { bindings: { "tui.select.cancel": "ctrl+x" } },
  );
});

for (const cancel of ["\u0018", "\u0003"]) {
  test(`nondefault cancel binding retains questionnaire cancellation for ${JSON.stringify(cancel)}`, async () => {
    await withDiscussion(
      async (f) => {
        await f.command("start");
        const running = f.execute("plan_mode_question", "cancel", { questions });
        await f.tui.waitForOpen();
        await f.dispatch(cancel);
        const result = await running;
        assert.equal(result.details.reason, "cancelled");
        assert.equal(result.terminate, undefined);
        assert.equal(f.state().interactionMode, "questions");
        assert.equal(f.aborts, 0);
        assert.equal(f.listeners.size, 1);
      },
      { bindings: { "tui.select.cancel": "ctrl+x" } },
    );
  });
}

for (const reason of ["reload", "resume", "fork"] as const) {
  test(`${reason} restores discussion without replaying questions or a ready menu`, async () => {
    await withDiscussion(async (f) => {
      await f.command("start");
      await f.dispatch(F2);
      await f.execute("plan_mode_complete", "ready", { plan: PLAN });
      f.branch.splice(0, f.branch.length, { type: "custom", customType: "plan-mode-state", data: f.state() });
      await f.emit("session_start", { reason });
      await f.emit("agent_settled");
      assert.match(f.context.statuses.get("plan-mode") ?? "", /ready/u);
      assert.match(renderMockWidget(f.context.widgets.get("plan-mode-plan")).join("\n"), /discussion/u);
      assert.equal(f.tui.openCount, 0);
      assert.equal(
        (await f.execute("plan_mode_question", "restored", { questions })).details.reason,
        "questions_paused",
      );
      await f.dispatch(F2);
      await f.emit("agent_settled");
      assert.equal(f.state().interactionMode, "questions");
      assert.equal(f.tui.openCount, 0);
      assert.equal(f.mock.sentUserMessages.length, 0);
    });
  });
}

test("F2 interrupts a public custom editor without stealing its editing, paste, or cancel keys", async () => {
  await withDiscussion(
    async (f) => {
      const ctx = f.context.ctx as ExtensionContext;
      let editor: EditorComponent | undefined;
      const received: string[] = [];
      ctx.ui.getEditorComponent = () => (host, theme) => {
        editor = new Editor(host, theme);
        const handleInput = editor.handleInput.bind(editor);
        editor.handleInput = (data) => {
          received.push(data);
          if (data !== "\u001b") handleInput(data);
        };
        return editor;
      };
      await f.command("start");
      f.setIdle(false);
      const running = f.execute("plan_mode_question", "custom-editor", { questions });
      await f.tui.waitForOpen();
      f.tui.setFocused(true);
      await f.dispatch("\u001b[B");
      await f.dispatch("\u001b[B");
      await f.dispatch("\r");
      assert.ok(editor);
      await f.dispatch("\u001b[200~jkn pasted text\u001b[201~");
      await f.dispatch("\u001b");
      assert.equal(f.tui.isOpen, true, "the custom editor retains its own Escape policy");
      await f.dispatch("\u007f");
      assert.equal(editor.getText(), "jkn pasted tex");
      assert.ok(received.includes("\u001b"));
      assert.ok(received.includes("\u007f"));
      await f.dispatch(F2);
      const result = await running;
      assert.equal(result.details.reason, "discussion_requested");
      assert.equal(result.details.answers, undefined);
      assert.equal(result.terminate, true);
      assert.equal(received.includes(F2), false, "the scoped listener consumes F2 before the custom editor");
      assert.equal(f.context.editorText, "main draft stays here");
    },
    { bindings: { "tui.select.cancel": "ctrl+x" } },
  );
});

test("discussion retains Plan mode read-only policy after ordinary plain-text turns", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    await f.dispatch(F2);
    await f.emit("agent_end", {
      messages: [{ role: "assistant", content: "Which scope do you prefer?", stopReason: "stop" }],
    });
    await f.emit("agent_settled");
    assert.equal(f.state().enabled, true);
    assert.equal(f.state().interactionMode, "discussion");
    assert.equal(f.tui.openCount, 0);
    for (const toolName of ["edit", "write"]) {
      const result = (await f.emit("tool_call", { toolName, input: { path: "file.ts", content: "changed" } })) as
        | { block?: boolean }
        | undefined;
      assert.equal(result?.block, true, toolName);
    }
    const read = await f.emit("tool_call", { toolName: "read", input: { path: "file.ts" } });
    assert.equal(read, undefined);
    assert.equal(f.mock.sentUserMessages.length, 0);
  });
});

test("RPC /plan menu switches both ways without opening TUI or sending a model turn", async () => {
  await withDiscussion(
    async (f) => {
      const offers: string[][] = [];
      const labels = ["Switch to free discussion", "Enable questionnaires"];
      (f.context.ctx as ExtensionContext).ui.select = async (_title, options) => {
        offers.push([...options]);
        const label = labels.shift();
        return options.find((option) => label !== undefined && option.includes(label));
      };
      await f.command("start");
      await f.command("");
      assert.equal(f.state().interactionMode, "discussion");
      assert.equal((await f.execute("plan_mode_question", "paused", { questions })).details.reason, "questions_paused");
      await f.command("");
      assert.equal(f.state().interactionMode, "questions");
      assert.equal(offers.length, 2);
      assert.equal(f.mock.sentUserMessages.length, 0);
      assert.equal(f.tui.openCount, 0);
    },
    { mode: "rpc" },
  );
});

test("tree navigation restores discussion and legacy branches restore the default questionnaire behavior", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    f.branch.splice(0, f.branch.length, {
      type: "custom",
      customType: "plan-mode-state",
      data: { enabled: true, awaitingAction: false, interactionMode: "discussion" },
    });
    await f.emit("session_tree");
    assert.equal(
      (await f.execute("plan_mode_question", "discussion-branch", { questions })).details.reason,
      "questions_paused",
    );
    assert.match(f.context.statuses.get("plan-mode") ?? "", /discussion/u);
    f.branch.splice(0, f.branch.length, {
      type: "custom",
      customType: "plan-mode-state",
      data: { enabled: true, awaitingAction: false },
    });
    await f.emit("session_tree");
    const running = f.execute("plan_mode_question", "legacy-branch", { questions });
    await f.tui.waitForOpen();
    f.tui.press("tui.select.cancel");
    assert.equal((await running).details.reason, "cancelled");
    assert.equal(f.mock.sentUserMessages.length, 0);
  });
});

test("saving a discussion plan clears its interaction mode and the next workflow starts with questionnaires", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    await f.dispatch(F2);
    await f.execute("plan_mode_complete", "ready", { plan: PLAN });
    await f.command("save");
    assert.equal(f.state().enabled, false);
    assert.equal(f.state().interactionMode, undefined);
    assert.equal(f.state().savedPlan?.plan, PLAN);
    await f.command("off");
    await f.command("start");
    assert.equal(f.state().interactionMode, "questions");
    const running = f.execute("plan_mode_question", "fresh-workflow", { questions });
    await f.tui.waitForOpen();
    f.tui.press("tui.select.cancel");
    assert.equal((await running).details.reason, "cancelled");
  });
});

for (const input of [F2, "\u001b[12~", "\u001b[[B", "\u001b[1;1Q", "\u001b[12;1~", "\u001b[12;1:1~"]) {
  test(`idle F2 accepts the native legacy or enhanced encoding ${JSON.stringify(input)}`, async () => {
    await withDiscussion(async (f) => {
      await f.command("start");
      await f.dispatch(input);
      assert.equal(f.state().interactionMode, "discussion");
      assert.equal(f.mock.sentUserMessages.length, 0);
      assert.equal(f.tui.openCount, 0);
    });
  });
}

test("idle input listener ignores F2 repeat/release and paste fragments before shortcut dispatch", async () => {
  await withDiscussion(async (f) => {
    setKittyProtocolActive(true);
    await f.command("start");
    for (const event of ["\u001b[12;1:2~", "\u001b[12;1:3~"]) assert.equal(await f.dispatch(event), true);
    for (const fragment of ["\u001b[20", "0~", F2, "\u001b[20", "1~"]) await f.dispatch(fragment);
    assert.equal(f.state().interactionMode, "questions");
    await f.dispatch(F2);
    assert.equal(f.state().interactionMode, "discussion");
    assert.equal(f.mock.sentUserMessages.length, 0);
  });
});

for (const boundary of ["session_tree", "session_start", "session_shutdown"] as const) {
  test(`${boundary} disposes an open questionnaire and stale F2 cannot change its successor`, async () => {
    await withDiscussion(async (f) => {
      await f.command("start");
      const running = f.execute("plan_mode_question", "obsolete", { questions });
      await f.tui.waitForOpen();
      const stale = f.capturedListeners.at(-1);
      assert.ok(stale);
      await f.emit(boundary, { reason: "new" });
      assert.equal((await running).details.answers, undefined);
      assert.equal(f.tui.isOpen, false);
      stale(F2);
      assert.equal(f.aborts, 0);
      assert.equal(f.listeners.size, boundary === "session_shutdown" ? 0 : 1);
    });
  });
}
