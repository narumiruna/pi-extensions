import assert from "node:assert/strict";
import { test } from "vitest";
import { F2, PLAN, withDiscussion } from "./discussion-support.js";
import { createMockContext } from "./support.js";
import { createMockWidget, widgetClick } from "./widget-support.js";

const KEY = "plan-mode-plan";
const EXPANDED = `─ ▾ Plan mode ${"─".repeat(106)}`;
const COLLAPSED = `─ ▸ Plan mode ${"─".repeat(106)}`;

test("retains Plan mode disclosure across interaction and ready-plan updates, with keyboard restoration", async () => {
  await withDiscussion(
    async (f) => {
      await f.command("start");
      let component = createMockWidget(f.context.widgets.get(KEY));
      const expanded = component.render(120);
      assert.equal(expanded[0], EXPANDED);
      assert.deepEqual(widgetClick(component, 0, 1, expanded.length), { handled: true, render: true });
      assert.deepEqual(component.render(120), [COLLAPSED]);
      component.dispose?.();

      await f.dispatch(F2);
      assert.equal(f.state().interactionMode, "discussion");
      component = createMockWidget(f.context.widgets.get(KEY));
      assert.deepEqual(component.render(120), [COLLAPSED]);
      component.dispose?.();
      await f.execute("plan_mode_complete", "ready", { plan: PLAN });
      await f.emit("agent_settled");
      component = createMockWidget(f.context.widgets.get(KEY));
      assert.deepEqual(component.render(120), [COLLAPSED]);
      assert.equal(f.state().latestPlan, PLAN);
      assert.equal(JSON.stringify(f.mock.entries).includes("collapsed"), false);

      const before = f.state();
      const running = f.command("");
      await Promise.race([
        f.tui.waitForOpen(),
        running.then(() => {
          throw new Error(`Plan menu did not open: ${JSON.stringify(f.context.notifications)}`);
        }),
      ]);
      component.dispose?.();
      component = createMockWidget(f.context.widgets.get(KEY));
      const restored = component.render(120);
      assert.equal(restored[0], EXPANDED);
      assert.ok(restored.includes("Proposed plan ready"));
      f.tui.press("ctrl+c");
      await running;
      assert.deepEqual(f.state(), before);
      // Click the blank right side of a body row, not its text.
      assert.deepEqual(widgetClick(component, 119, 1, restored.length), { handled: true, render: true });
      assert.deepEqual(component.render(120), [COLLAPSED]);
    },
    { bindings: { "tui.select.cancel": "ctrl+q" } },
  );
});

test("retains Plan disclosure on tree restoration but resets on session replacement and rejects stale input", async () => {
  await withDiscussion(async (f) => {
    await f.command("start");
    f.branch.push({ type: "custom", customType: "plan-mode-state", data: f.state() });
    const previous = createMockWidget(f.context.widgets.get(KEY));
    const height = previous.render(120).length;
    widgetClick(previous, 119, 1, height);
    assert.deepEqual(previous.render(120), [COLLAPSED]);
    previous.dispose?.();

    await f.emit("session_tree");
    const remount = createMockWidget(f.context.widgets.get(KEY));
    assert.deepEqual(remount.render(120), [COLLAPSED]);
    assert.equal(widgetClick(previous, 119, 1, height), undefined);
    remount.dispose?.();

    const replacement = createMockContext({
      mode: "tui",
      sessionManager: { getBranch: () => f.branch },
    });
    Object.defineProperty(f.context.ctx, "ui", {
      get() {
        throw new Error("Replaced context UI is stale");
      },
    });
    f.replaceContext(replacement);
    await f.emit("session_start", { reason: "resume" });
    const current = createMockWidget(replacement.widgets.get(KEY));
    assert.equal(current.render(120)[0], EXPANDED);
    assert.equal(widgetClick(remount, 119, 1, height), undefined);
    await f.emit("session_shutdown", {}, f.context.ctx);
    assert.equal(current.render(120)[0], EXPANDED);
    assert.equal(f.state().enabled, true);
  });
});
