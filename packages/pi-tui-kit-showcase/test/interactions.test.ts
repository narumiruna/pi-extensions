import { stripVTControlCharacters } from "node:util";
import { type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { createTuiHarness, type TuiHarnessOptions } from "@narumitw/pi-tui-kit/testing";
import { describe, expect, onTestFinished, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createInitialShowcaseState, createShowcaseMenu } from "../src/menu.js";
import { showTuiKitShowcase } from "../src/runtime.js";

const STANDALONE_IDS = [
  "documentReview",
  "multiSelect",
  "secretInput",
  "modelSelector",
  "thinkingSelector",
  "liveChoiceSearch",
  "live-choice",
  "confirmation",
  "questionnaire",
] as const;

describe("standalone showcase interactions", () => {
  test.each(STANDALONE_IDS)("%s returns to the menu on Back", async (id) => {
    const demo = await startDemo();
    await demo.openMain(id);
    const opens = demo.tui.openCount;
    const closed = demo.tui.resultPromise;
    demo.tui.press("tui.select.cancel");
    await closed;
    await demo.tui.waitForOpen();
    expect(demo.tui.openCount).toBe(opens + 1);
    expect(demo.frame()).toContain("Pi TUI Kit Showcase");
  });

  test.each(STANDALONE_IDS)("%s exits the entire flow on Ctrl+C", async (id) => {
    const demo = await startDemo();
    await demo.openMain(id);
    const opens = demo.tui.openCount;
    demo.tui.press("ctrl+c");
    await demo.running;
    expect(demo.tui.isOpen).toBe(false);
    expect(demo.tui.openCount).toBe(opens);
  });

  test.each(STANDALONE_IDS)("%s does not reopen after external disposal", async (id) => {
    const demo = await startDemo();
    await demo.openMain(id);
    demo.tui.dispose();
    await demo.running;
    expect(demo.tui.isOpen).toBe(false);
    expect(demo.context.notifications).toEqual([]);
  });

  test.each(STANDALONE_IDS)("%s releases its UI when the owner is replaced", async (id) => {
    const demo = await startDemo();
    await demo.openMain(id);
    demo.owner.abort();
    await demo.running;
    expect(demo.tui.isOpen).toBe(false);
    expect(demo.context.notifications).toEqual([]);
  });

  test.each(["complete", "cancel", "replace", "dispose"])("task loader releases work after %s", async (mode) => {
    const demo = await startDemo();
    await demo.openMain("task");
    // The busy-label menu can open once before the standalone loader owns the UI.
    await expect.poll(() => (demo.tui.isOpen ? demo.frame() : "")).toContain("Running a short showcase task");
    const closed = demo.tui.resultPromise;
    if (mode === "cancel") demo.tui.press("ctrl+c");
    else if (mode === "replace") demo.owner.abort();
    else if (mode === "dispose") demo.tui.dispose();
    if (mode === "replace" || mode === "dispose") {
      await demo.running;
      expect(demo.tui.isOpen).toBe(false);
      expect(demo.context.notifications).toEqual([]);
    } else {
      await closed;
      await demo.tui.waitForOpen();
      expect(demo.frame()).toContain("Pi TUI Kit Showcase");
      expect(demo.context.notifications).toEqual(
        mode === "complete" ? [{ message: "Showcase task completed.", level: "info" }] : [],
      );
    }
  });

  test.each(["modelSelector", "thinkingSelector"] as const)(
    "%s selection does not change the demo default",
    async (id) => {
      const demo = await startDemo();
      await demo.openMain(id);
      demo.tui.type(id === "modelSelector" ? "detailed" : "max");
      const closed = demo.tui.resultPromise;
      demo.tui.press("tui.select.confirm");
      await closed;
      await demo.tui.waitForOpen();
      await demo.openMain(id);
      const frame = demo.frame();
      expect(frame).toContain(id === "modelSelector" ? "balanced [demo] · default" : "high · default");
      expect(frame).not.toContain(id === "modelSelector" ? "detailed [demo] · default" : "max · default");
    },
  );

  test("records a confirmed standalone document review", async () => {
    const demo = await startDemo();
    await demo.openMain("documentReview");
    expect(demo.frame()).toContain('"profile": "Balanced"');
    demo.tui.press("tui.select.confirm");
    await demo.tui.waitForOpen();
    expect(demo.context.notifications).toContainEqual({ message: "Document review recorded.", level: "info" });
  });

  test("discards masked input without exposing its value", async () => {
    const demo = await startDemo();
    await demo.openMain("secretInput");
    demo.tui.press("tui.input.submit");
    expect(demo.context.notifications.at(-1)?.level).toBe("warning");
    const secret = "sample-PRIVATE-credential";
    demo.tui.send(`\x1b[200~${secret}\x1b[201~`);
    expect(demo.frame()).not.toContain(secret);
    expect(demo.frame()).toContain("•••");
    demo.tui.press("tui.input.submit");
    await demo.tui.waitForOpen();
    expect(JSON.stringify(demo.context.notifications)).not.toContain(secret);
    expect(demo.context.notifications.at(-1)?.message).toBe("Demo secret discarded.");
    await demo.openMain("actions");
    expect(demo.frame()).toContain("Masked demo input submitted and discarded.");
    expect(demo.frame()).not.toContain(secret);
  });

  test.each(["apply", "cancel"] as const)("standalone multi-select keeps edits local until %s", async (mode) => {
    const demo = await startDemo();
    await demo.openMain("multiSelect");
    demo.tui.type("bulk");
    demo.tui.press("tui.select.confirm");
    await demo.tui.waitForPending();
    const closed = demo.tui.resultPromise;
    if (mode === "apply") {
      demo.tui.press("tui.select.down");
      demo.tui.press("tui.select.confirm");
    } else demo.tui.press("tui.select.cancel");
    await closed;
    await demo.tui.waitForOpen();
    await demo.openMain("documentReview");
    expect(demo.frame()).toContain(`"bulk": ${mode === "apply"}`);
  });

  test.each(["modelSelector", "thinkingSelector"] as const)(
    "%s saves only demo current and default state",
    async (id) => {
      const demo = await startDemo();
      await demo.openMain(id);
      demo.tui.type(id === "modelSelector" ? "detailed" : "max");
      demo.tui.press("app.models.save");
      await demo.tui.waitForOpen();
      await demo.openMain(id);
      const expected = id === "modelSelector" ? "detailed [demo] · default" : "max · default";
      expect(demo.frame()).toContain(expected);
      expect(demo.context.notifications).toEqual([]);
    },
  );

  test.each(["apply", "cancel"] as const)("searchable live choice handles %s without shortcuts", async (mode) => {
    const demo = await startDemo();
    await demo.openMain("liveChoiceSearch");
    expect(demo.frame()).not.toContain("note details");
    demo.tui.type("small");
    expect(demo.frame()).toContain("Minimal");
    if (mode === "apply") demo.tui.press("tui.select.confirm");
    else demo.tui.press("tui.select.cancel");
    await demo.tui.waitForOpen();
    expect(demo.frame()).toContain(`Current demo state: ${mode === "apply" ? "Minimal" : "Balanced"}`);
  });

  test("live choice keeps shortcuts available on the current confirmation-disabled row", async () => {
    const demo = await startDemo();
    await demo.openMain("live-choice");
    expect(demo.frame()).toContain("Already applied");
    demo.tui.press("tui.select.confirm");
    expect(demo.tui.isOpen).toBe(true);
    demo.tui.type("d");
    await demo.tui.waitForOpen();
    await demo.openMain("actions");
    expect(demo.frame()).toContain("Live choice shortcut details.");
  });

  test("uses remapped selector keys while retaining hard Ctrl+C", async () => {
    const bindings: Record<string, { key: KeyId; data: string }> = {
      "tui.select.confirm": { key: "f2", data: "\x1bOQ" },
      "tui.select.cancel": { key: "f3", data: "\x1bOR" },
      "tui.select.down": { key: "down", data: "\x1b[B" },
      "tui.select.up": { key: "up", data: "\x1b[A" },
      "app.models.save": { key: "f4", data: "\x1bOS" },
    };
    const demo = await startDemo({
      keybindings: {
        matches: (data, binding) => bindings[binding]?.data === data,
        getKeys: (binding) => (bindings[binding] ? [bindings[binding].key] : []),
      },
    });
    await demo.openMain("modelSelector", "\x1bOQ");
    expect(demo.frame()).toContain("f4 set as default");
    demo.tui.send("\x1bOS");
    await demo.tui.waitForOpen();
    await demo.openMain("secretInput", "\x1bOQ");
    demo.tui.press("ctrl+c");
    await demo.running;
    expect(demo.tui.isOpen).toBe(false);
  });
});

describe("showcase input and reviews", () => {
  test("retains a rejected draft, accepts editing and paste, then reopens with a prefill", async () => {
    const demo = await startDemo();
    await demo.openMain("input");
    expect(demo.frame()).toContain("Demo note");
    demo.tui.send("\x15");
    demo.tui.send(`\x1b[200~${"x".repeat(81)}\x1b[201~`);
    demo.tui.press("tui.input.submit");
    await demo.tui.waitForPending();
    expect(demo.frame()).toContain("x".repeat(81));
    expect(demo.context.notifications.at(-1)?.level).toBe("warning");
    demo.tui.send("\x15");
    demo.tui.send("\x1b[200~A pasted note!\x1b[201~");
    demo.tui.send("\x7f");
    demo.tui.press("tui.input.submit");
    await demo.tui.waitForPending();
    await demo.tui.waitForOpen();
    // The declarative menu keeps the highlighted main-menu row after Back.
    demo.tui.press("tui.select.confirm");
    await demo.tui.waitForOpen();
    expect(demo.frame()).toContain("Current draft: A pasted note");
    expect(demo.frame()).not.toContain("A pasted note!");
  });

  test.each(["text", "code", "diff", "markdown-rich", "markdown-source"])(
    "renders %s review across narrow sizes",
    async (id) => {
      const demo = await startDemo();
      await demo.openMain("review");
      const menu = createShowcaseMenu({ requestStandalone() {} });
      const picker = resolveMenuScreen(menu, "reviewFormats", createInitialShowcaseState());
      if (picker.kind !== "actions") throw new Error("Expected a format picker");
      const index = picker.items.findIndex((item) => item.id === id);
      for (let row = 0; row < index; row += 1) demo.tui.press("tui.select.down");
      demo.tui.press("tui.select.confirm");
      await demo.tui.waitForOpen();
      expect(demo.frame()).toMatch(/review/iu);
      for (const width of [1, 12, 40, 100]) {
        const lines = demo.tui.resize({ width, rows: 20 });
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        demo.tui.invalidate();
        expect(demo.tui.render().every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    },
  );
});

async function startDemo(options: TuiHarnessOptions = {}) {
  const tui = createTuiHarness({ width: 120, rows: 50, ...options });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const owner = new AbortController();
  const running = showTuiKitShowcase(context.ctx, {
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
  });
  onTestFinished(async () => {
    owner.abort();
    tui.dispose();
    await running;
  });
  await tui.waitForOpen();
  return {
    tui,
    context,
    owner,
    running,
    frame: () => stripVTControlCharacters(tui.render().join("\n")),
    async openMain(id: string, confirm = "\r") {
      const main = resolveMenuScreen(
        createShowcaseMenu({ requestStandalone() {} }),
        "main",
        createInitialShowcaseState(),
      );
      if (main.kind !== "actions") throw new Error("Expected main actions");
      const index = main.items.findIndex((item) => item.id === id);
      expect(index).toBeGreaterThanOrEqual(0);
      tui.press("home");
      for (let row = 0; row < index; row += 1) tui.press("tui.select.down");
      const closed = tui.resultPromise;
      tui.send(confirm);
      await closed;
      await tui.waitForOpen();
    },
  };
}
