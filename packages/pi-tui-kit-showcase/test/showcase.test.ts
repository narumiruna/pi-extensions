import { stripVTControlCharacters } from "node:util";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { describe, expect, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import extension from "../src/index.js";
import { createInitialShowcaseState, createShowcaseMenu } from "../src/menu.js";
import { showTuiKitShowcase } from "../src/runtime.js";
import { createPiTuiKitShowcaseExtension } from "../src/showcase.js";

describe("Pi TUI Kit showcase", () => {
  test("exposes every standard Kit screen from the main menu", () => {
    const state = createInitialShowcaseState();
    const menu = createShowcaseMenu({ requestStandalone: () => {} });

    const screenKinds = [
      "main",
      "actions",
      "detail",
      "browse",
      "choice",
      "settings",
      "input",
      "review",
      "multiSelect",
    ].map((screen) => resolveMenuScreen(menu, screen, state).kind);

    expect(screenKinds).toEqual([
      "actions",
      "actions",
      "detail",
      "browse",
      "choice",
      "settings",
      "input",
      "review",
      "multiSelect",
    ]);

    const main = resolveMenuScreen(menu, "main", state);
    expect(main.kind).toBe("actions");
    if (main.kind !== "actions") return;
    expect(main.items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["Questionnaire", "Task loader", "Confirmation", "Live choice"]),
    );
  });

  test("renders shared rules on showcase screens that previously had no frame", async () => {
    const tui = createTuiHarness({ width: 60, rows: 24 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const owner = new AbortController();
    const running = showTuiKitShowcase(context.ctx, {
      signal: owner.signal,
      isCurrent: () => !owner.signal.aborted,
    });

    await tui.waitForOpen();
    assertRules(tui.render(), 60);
    const main = resolveMenuScreen(
      createShowcaseMenu({ requestStandalone: () => {} }),
      "main",
      createInitialShowcaseState(),
    );
    const detailIndex = main.kind === "actions" ? main.items.findIndex((item) => item.id === "detail") : -1;
    expect(detailIndex).toBeGreaterThanOrEqual(0);
    for (let index = 0; index < detailIndex; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assertRules(tui.render(), 60);

    tui.press("ctrl+c");
    await running;
  });

  test("runs the questionnaire interaction and reopens the showcase menu", async () => {
    const tui = createTuiHarness({ width: 100, rows: 30 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const owner = new AbortController();
    const running = showTuiKitShowcase(context.ctx, {
      signal: owner.signal,
      isCurrent: () => !owner.signal.aborted,
    });

    await tui.waitForOpen();
    const main = resolveMenuScreen(
      createShowcaseMenu({ requestStandalone: () => {} }),
      "main",
      createInitialShowcaseState(),
    );
    const questionnaireIndex =
      main.kind === "actions" ? main.items.findIndex((item) => item.id === "questionnaire") : -1;
    expect(questionnaireIndex).toBeGreaterThanOrEqual(0);
    for (let index = 0; index < questionnaireIndex; index += 1) {
      tui.press("tui.select.down");
    }
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    expect(tui.render().join("\n")).toMatch(/\[Layout\] {2}Validation {2}Review/u);
    tui.press("tui.select.confirm");
    tui.press("tui.select.confirm");
    expect(tui.render().join("\n")).toMatch(/1\. Layout — Compact[\s\S]*2\. Validation — Strict/u);
    tui.press("tui.select.confirm");

    await tui.waitForOpen();
    expect(context.notifications.map(({ message }) => message)).toContain("Questionnaire submitted.");
    owner.abort();
    await running;
    expect(tui.isOpen).toBe(false);
  });

  test("registers one TUI-only showcase command and rejects arguments", async () => {
    const commands = new Map<string, ShowcaseCommand>();
    extension({
      registerCommand(name: string, command: ShowcaseCommand) {
        commands.set(name, command);
      },
      on() {},
    } as never);

    expect([...commands.keys()]).toEqual(["tui-kit-showcase"]);
    await expect(commands.get("tui-kit-showcase")?.handler("extra", {})).rejects.toThrow("Usage: /tui-kit-showcase");
  });

  test("reports RPC unsupported mode without loading the TUI runtime", async () => {
    const notifications: string[] = [];
    const commands = new Map<string, ShowcaseCommand>();
    createPiTuiKitShowcaseExtension({
      loadRuntime: async () => {
        throw new Error("runtime should not load");
      },
    })({
      registerCommand(name: string, command: ShowcaseCommand) {
        commands.set(name, command);
      },
      on() {},
    } as never);

    await commands.get("tui-kit-showcase")?.handler("", {
      mode: "rpc",
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
    });

    expect(notifications).toEqual([
      "Pi TUI Kit Showcase is an interactive visual demo. Run /tui-kit-showcase in TUI mode.",
    ]);
  });

  test("aborts command-owned showcase work on session shutdown", async () => {
    let captured:
      | {
          signal: AbortSignal;
          isCurrent(): boolean;
        }
      | undefined;
    const commands = new Map<string, ShowcaseCommand>();
    const events = new Map<string, () => void>();
    createPiTuiKitShowcaseExtension({
      loadRuntime: async () => ({
        showTuiKitShowcase: async (_ctx, options) => {
          captured = options;
        },
      }),
    })({
      registerCommand(name: string, command: ShowcaseCommand) {
        commands.set(name, command);
      },
      on(name: string, handler: () => void) {
        events.set(name, handler);
      },
    } as never);

    await commands.get("tui-kit-showcase")?.handler("", { mode: "tui", hasUI: true, ui: {} });

    expect(captured?.signal.aborted).toBe(false);
    expect(captured?.isCurrent()).toBe(true);
    events.get("session_shutdown")?.();
    expect(captured?.signal.aborted).toBe(true);
    expect(captured?.isCurrent()).toBe(false);
  });
});

function assertRules(lines: readonly string[], width: number) {
  expect(stripVTControlCharacters(lines[0] ?? "")).toBe("─".repeat(width));
  expect(stripVTControlCharacters(lines.at(-1) ?? "")).toBe("─".repeat(width));
}

interface ShowcaseCommand {
  handler(args: string, ctx: unknown): Promise<void>;
}
