import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKittyProtocolActive,
  type KeybindingsConfig,
  KeybindingsManager,
  matchesKey,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { vi } from "vitest";
import type { PlanModeState } from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

export const DISCUSSION_QUESTIONS = [
  {
    id: "scope",
    header: "Scope",
    question: "How broad?",
    options: [
      { label: "Small", description: "Only the bug." },
      { label: "Broad", description: "Include cleanup." },
    ],
  },
  {
    id: "tests",
    header: "Tests",
    question: "Which checks?",
    options: [
      { label: "Focused", description: "Run focused checks." },
      { label: "Full", description: "Run all checks." },
    ],
  },
];
export const F2 = "\u001bOQ";
export const PLAN = "# Discussion plan\n\n1. Implement the agreed change.\n2. Run focused checks.";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: { cancelled?: boolean; reason?: string; answers?: unknown[]; plan?: string };
  terminate?: boolean;
}

export async function withDiscussion(
  run: (fixture: Awaited<ReturnType<typeof discussionFixture>>) => Promise<void>,
  options: Parameters<typeof discussionFixture>[0] = {},
) {
  const fixture = await discussionFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function discussionFixture(
  options: {
    bindings?: KeybindingsConfig;
    nativeBindings?: boolean;
    mode?: "tui" | "rpc" | "print" | "json";
    branch?: unknown[];
    loadInteractiveUi?(): Promise<typeof import("../src/interactive-ui.js")>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-discussion-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousKeys = getKeybindings();
  const previousKitty = isKittyProtocolActive();
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  const { default: planMode } = await import("../src/plan-mode.js");
  let keys = new KeybindingsManager(TUI_KEYBINDINGS, options.bindings);
  if (options.nativeBindings) {
    // Use Pi's installed app registry, not a synthetic action, to test native conflicts.
    const { KeybindingsManager: AppKeys } = (await import(
      new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
    )) as { KeybindingsManager: new (bindings?: KeybindingsConfig) => KeybindingsManager };
    keys = new AppKeys(options.bindings);
  }
  setKeybindings(keys);
  const tui = createTuiHarness({ width: 80, rows: 30, keybindings: keys });
  const mock = createMockPi({ activeTools: ["read", "bash", "edit", "write"] });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "missing" as const }),
    ...(options.loadInteractiveUi ? { loadInteractiveUi: options.loadInteractiveUi } : {}),
  });
  const listeners = new Set<TerminalInputHandler>();
  const capturedListeners: TerminalInputHandler[] = [];
  const branch = options.branch ?? [];
  let idle = true;
  let aborts = 0;
  const context = createMockContext({
    cwd: directory,
    mode: options.mode ?? "tui",
    editorText: "main draft stays here",
    custom: tui.custom,
    isIdle: () => idle,
    abort: () => {
      aborts += 1;
    },
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getSessionId: () => "discussion-session",
      getSessionName: () => undefined,
      getEntry: (id: string) => branch.find((entry) => (entry as { id?: string }).id === id),
    },
    onTerminalInput(listener: TerminalInputHandler) {
      listeners.add(listener);
      capturedListeners.push(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  let currentContext = context;
  async function emit(name: string, event: unknown = {}, ctx = currentContext.ctx) {
    let result: unknown;
    for (const listener of mock.events.get(name) ?? []) result = await listener(event, ctx);
    return result;
  }
  await emit("session_start", { reason: "startup" });
  function state(): PlanModeState {
    const entry = mock.entries.findLast((entry) => entry.customType === "plan-mode-state");
    assert.ok(entry, "expected a persisted Plan state");
    return entry.data as PlanModeState;
  }
  function execute(name: string, id: string, params: unknown, ctx = currentContext.ctx) {
    const tool = mock.tools.find((tool) => tool.name === name);
    assert.ok(tool && typeof tool.execute === "function");
    return tool.execute(id, params, undefined, undefined, ctx) as Promise<ToolResult>;
  }
  async function command(text: string) {
    const command = mock.commands.get("plan");
    assert.ok(command);
    return command.handler(text, currentContext.ctx);
  }
  async function dispatch(data: string) {
    // Match Pi's order: raw listeners, registered shortcuts, then the focused editor.
    for (const listener of [...listeners]) {
      const result = listener(data);
      if (result?.consume) return true;
      if (result?.data !== undefined) data = result.data;
    }
    if (tui.isOpen) tui.send(data);
    else {
      const shortcut = [...mock.shortcuts].find(([key]) => matchesKey(data, key));
      if (shortcut) await shortcut[1].handler(currentContext.ctx);
      else if (/^[\x20-\x7e]+$/u.test(data)) {
        const ui = (currentContext.ctx as ExtensionContext).ui;
        ui.setEditorText(ui.getEditorText() + data);
      }
    }
    return false;
  }
  return {
    mock,
    tui,
    context,
    keys,
    listeners,
    capturedListeners,
    branch,
    state,
    execute,
    command,
    emit,
    dispatch,
    setIdle(value: boolean) {
      idle = value;
    },
    replaceContext(next: ReturnType<typeof createMockContext>) {
      currentContext = next;
    },
    get aborts() {
      return aborts;
    },
    async dispose() {
      try {
        await emit("session_shutdown", { reason: "quit" });
        assert.equal(listeners.size, 0, "shutdown must release all terminal listeners");
        assert.equal(tui.isOpen, false, "shutdown must close an owned questionnaire");
      } finally {
        setKittyProtocolActive(previousKitty);
        setKeybindings(previousKeys);
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
