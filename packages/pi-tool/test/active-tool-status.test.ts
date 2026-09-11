import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import {
  ACTIVE_TOOL_REFRESH_INTERVAL_MS,
  ACTIVE_TOOL_WIDGET_KEY,
  createActiveToolStatusController,
  formatActiveToolWidget,
  renderActiveToolWidget,
  sanitizeToolName,
} from "../src/active-tool-status.js";

type WidgetFactory = (_tui: never, theme: Theme) => Component;
type WidgetRecord = [string, string[] | WidgetFactory | undefined, { placement: "aboveEditor" } | undefined];

const DIVIDER = "─".repeat(80);
const IDENTITY_THEME = {
  fg: (_role: string, text: string) => text,
} as unknown as Theme;

afterEach(() => {
  vi.useRealTimers();
});

function createHarness(initialTools: string[] = []) {
  let activeTools = initialTools;
  const pi = {
    getActiveTools() {
      return [...activeTools];
    },
  } as unknown as ExtensionAPI;
  return {
    controller: createActiveToolStatusController(pi),
    setActiveTools(toolNames: string[]) {
      activeTools = toolNames;
    },
  };
}

function createContext(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
  const widgets: WidgetRecord[] = [];
  const sessionManager = {} as ExtensionContext["sessionManager"];
  const ctx = {
    mode,
    hasUI,
    sessionManager,
    ui: {
      setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: { placement: "aboveEditor" }) {
        widgets.push([key, content, options]);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets };
}

function renderWidgetRecord(record: WidgetRecord | undefined, width = 80): WidgetRecord | undefined {
  if (!record) return undefined;
  const [key, content, options] = record;
  const rendered = typeof content === "function" ? content(undefined as never, IDENTITY_THEME).render(width) : content;
  return [key, rendered, options];
}

test("stays off by default and can start, refresh, and stop in the owned session", async () => {
  vi.useFakeTimers();
  const harness = createHarness(["read", "bash"]);
  const current = createContext();
  harness.controller.start(current.ctx, false);
  assert.deepEqual(current.widgets, []);

  harness.controller.setEnabled(current.ctx, true);
  assert.deepEqual(renderWidgetRecord(current.widgets.at(-1)), [
    ACTIVE_TOOL_WIDGET_KEY,
    [DIVIDER, "Active tools (2)", "read · bash"],
    { placement: "aboveEditor" },
  ]);

  harness.setActiveTools(["read", "edit", "write"]);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  assert.deepEqual(renderWidgetRecord(current.widgets.at(-1)), [
    ACTIVE_TOOL_WIDGET_KEY,
    [DIVIDER, "Active tools (3)", "read · edit · write"],
    { placement: "aboveEditor" },
  ]);

  harness.controller.setEnabled(current.ctx, false);
  assert.deepEqual(current.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);
  const countAfterDisable = current.widgets.length;
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS * 2);
  assert.equal(current.widgets.length, countAfterDisable);
});

test("session replacement clears the old widget and ignores stale shutdown", () => {
  const harness = createHarness(["read"]);
  const previous = createContext();
  const current = createContext();
  harness.controller.start(previous.ctx, true);
  harness.controller.start(current.ctx, true);
  assert.deepEqual(previous.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);

  harness.controller.shutdown(previous.ctx);
  assert.equal(harness.controller.isEnabled(), true);
  harness.controller.shutdown(current.ctx);
  assert.deepEqual(current.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);
});

test("keeps RPC widget content as plain strings and does nothing without UI", () => {
  const harness = createHarness(["read"]);
  const rpc = createContext("rpc");
  harness.controller.start(rpc.ctx, true);
  assert.deepEqual(rpc.widgets.at(-1), [
    ACTIVE_TOOL_WIDGET_KEY,
    ["Active tool (1)", "read"],
    { placement: "aboveEditor" },
  ]);
  const print = createContext("print", false);
  harness.controller.start(print.ctx, true);
  assert.deepEqual(print.widgets, []);
  harness.controller.shutdown(print.ctx);
});

test("renders a muted divider and wraps every safe tool name within the available width", () => {
  const roles: string[] = [];
  const theme = {
    fg(role: string, text: string) {
      roles.push(role);
      return text;
    },
  } as unknown as Theme;
  const lines = renderActiveToolWidget(
    ["Active tools (6)", "read · bash · edit · write · runtime_diagnostics · subagent_spawn"],
    theme,
    40,
  );

  assert.deepEqual(lines.map(stripTerminalSequences), [
    "─".repeat(40),
    "Active tools (6)",
    "read · bash · edit · write ·",
    "runtime_diagnostics · subagent_spawn",
  ]);
  assert.deepEqual(roles, ["borderMuted"]);
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});

test("formats every tool as bounded safe display text", () => {
  assert.deepEqual(formatActiveToolWidget(["read", "bash", "edit", "write"]), [
    "Active tools (4)",
    "read · bash · edit · write",
  ]);
  assert.deepEqual(formatActiveToolWidget(["read\n\u001b[31m"]), ["Active tool (1)", "read31m"]);
  assert.equal(sanitizeToolName("\u001b]8;;bad\u0007read\n\u202efile"), "8badreadfile");
  assert.equal(sanitizeToolName("\u001b\u0007"), "tool");
  assert.equal(sanitizeToolName("x".repeat(40)), `${"x".repeat(32)}…`);
});
