import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { DISCUSSION_QUESTIONS, F2, PLAN, withDiscussion } from "./discussion-support.js";
import { renderMockWidget } from "./widget-support.js";

for (const resumeBeforeLoad of [false, true]) {
  test(`discussion cancels a lazy automatic ready menu (resume=${resumeBeforeLoad})`, async () => {
    const started = Promise.withResolvers<void>();
    const ui = Promise.withResolvers<typeof import("../src/interactive-ui.js")>();
    let menus = 0;
    await withDiscussion(
      async (f) => {
        await f.command("start");
        await f.execute("plan_mode_complete", "complete", { plan: PLAN });
        const settling = f.emit("agent_settled");
        await started.promise;
        await f.dispatch(F2);
        assert.equal(f.state().interactionMode, "discussion");
        if (resumeBeforeLoad) await f.dispatch(F2);
        ui.resolve({
          showReadyPlanMenu: async () => {
            menus += 1;
          },
        } as never);
        await settling;
        assert.equal(menus, 0);
        assert.equal(f.state().latestPlan, PLAN);
        assert.equal(f.mock.sentUserMessages.length, 0);
      },
      {
        loadInteractiveUi: () => {
          started.resolve();
          return ui.promise;
        },
      },
    );
  });
}

test("non-question custom screens hide and disable the editor-only F2 action", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    const widget = () => renderMockWidget(f.context.widgets.get("plan-mode-plan")).join("\n");
    assert.match(widget(), /F2/);
    await f.emit("ui_prompt_start", { reason: "ui_prompt", kind: "custom" });
    assert.doesNotMatch(widget(), /F2/);
    await f.dispatch(F2);
    assert.equal(f.state().interactionMode, "questions");
    await f.emit("ui_prompt_end", { reason: "ui_prompt" });
    assert.match(widget(), /F2/);
    await f.dispatch(F2);
    assert.equal(f.state().interactionMode, "discussion");
  });
});

test("busy RPC custom-answer editor rejects a manual interaction switch without closing the question", async () => {
  await withDiscussion(
    async (f) => {
      const editorOpened = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<string>();
      const ctx = f.context.ctx as ExtensionContext;
      ctx.ui.select = async (_title, rows) =>
        rows.find((row) => row.startsWith("Switch to free discussion")) ?? rows.at(-1);
      ctx.ui.editor = async () => {
        editorOpened.resolve();
        return answer.promise;
      };
      await f.command("start");
      f.setIdle(false);
      const running = f.execute("plan_mode_question", "rpc-question", { questions: [DISCUSSION_QUESTIONS[0]] });
      await editorOpened.promise;
      try {
        await f.command("");
        assert.equal(f.state().interactionMode, "questions");
        assert.equal(f.aborts, 0);
        assert.match(f.context.notifications.at(-1)?.message ?? "", /settle/);
      } finally {
        answer.resolve("Unsubmitted editor remained open until this explicit answer");
        await running;
        f.setIdle(true);
      }
    },
    { mode: "rpc" },
  );
});
