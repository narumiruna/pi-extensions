import assert from "node:assert/strict";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import progressWidgetExtension, {
  type ProgressDetails,
  type ProgressStep,
  type ProgressWidgetDependencies,
  TOOL_NAME,
} from "../src/progress-widget.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressSettings, type ProgressSettingsLoadResult } from "../src/settings.js";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type WidgetFactory = (tui: TUI, theme: Theme) => Component;

export interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  prepareArguments(args: unknown): { steps: ProgressStep[] };
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: ProgressDetails }>;
}

export function defaultSettingsResult(): ProgressSettingsLoadResult {
  return {
    kind: "missing",
    path: "/tmp/pi-progress.json",
    settings: { ...DEFAULT_PROGRESS_SETTINGS },
  };
}

export function loadedSettings(settings: Partial<ProgressSettings>): ProgressSettingsLoadResult {
  return {
    kind: "loaded",
    path: "/tmp/pi-progress.json",
    settings: { ...DEFAULT_PROGRESS_SETTINGS, ...settings },
  };
}

export function createHarness(options: ProgressWidgetDependencies = {}) {
  const handlers = new Map<string, Handler[]>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const tools: RegisteredTool[] = [];
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(definition: RegisteredTool) {
      tools.push(definition);
    },
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data: structuredClone(data) });
    },
  } as unknown as ExtensionAPI;
  progressWidgetExtension(pi, {
    ...options,
    loadSettings: options.loadSettings ?? (async () => defaultSettingsResult()),
  });

  return {
    entries,
    tools,
    commands,
    get tool(): RegisteredTool {
      assert.equal(tools.length, 1);
      const tool = tools[0];
      assert.ok(tool);
      return tool;
    },
    async emit(event: string, ctx: ExtensionContext, payload: unknown = {}) {
      for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx);
    },
    async context(messages: ContextEvent["messages"], ctx: ExtensionContext) {
      let current = messages;
      for (const handler of handlers.get("context") ?? []) {
        const result = (await handler({ messages: current } as never, ctx)) as
          | { messages?: ContextEvent["messages"] }
          | undefined;
        current = result?.messages ?? current;
      }
      return current;
    },
  };
}

export function createContext(
  options: {
    mode?: ExtensionContext["mode"];
    hasUI?: boolean;
    branch?: SessionEntry[];
    terminalRows?: number;
    isIdle?: () => boolean;
  } = {},
) {
  const widgets: Array<{
    key: string;
    content: WidgetFactory | undefined;
    lines?: string[];
    options: { placement: "aboveEditor" } | undefined;
  }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const branch = options.branch ?? [];
  let component: (Component & { dispose?(): void }) | undefined;
  let renderRequests = 0;
  const terminal = { rows: options.terminalRows ?? 36 };
  let activeTheme = identityTheme().theme;
  const tui = {
    terminal,
    requestRender: () => {
      renderRequests++;
    },
  } as unknown as TUI;
  const sessionManager = {
    getBranch: () => branch,
  } as unknown as ExtensionContext["sessionManager"];
  const mode = options.mode ?? "tui";
  const ctx = {
    mode,
    hasUI: options.hasUI ?? (mode === "tui" || mode === "rpc"),
    sessionManager,
    isIdle: options.isIdle ?? (() => true),
    ui: {
      get theme() {
        return activeTheme;
      },
      setWidget(
        key: string,
        content: WidgetFactory | string[] | undefined,
        widgetOptions?: { placement: "aboveEditor" },
      ) {
        // Match Pi RPC: clear and string-array calls are emitted; factories are ignored.
        if (mode === "rpc" && typeof content === "function") return;
        component?.dispose?.();
        component = undefined;
        if (Array.isArray(content)) {
          widgets.push({ key, content: undefined, lines: [...content], options: widgetOptions });
        } else if (content) {
          // Pi invokes a factory once at mount. Render that retained component,
          // rather than calling the original factory again after every update.
          const mounted = content(tui, ctx.ui.theme);
          component = mounted;
          widgets.push({ key, content: () => mounted, options: widgetOptions });
        } else {
          widgets.push({ key, content, options: widgetOptions });
        }
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;
  return {
    branch,
    ctx,
    notifications,
    tui,
    widgets,
    setRows(rows: number) {
      terminal.rows = rows;
    },
    setTheme(theme: Theme) {
      activeTheme = theme;
    },
    get component() {
      return component;
    },
    get renderRequests() {
      return renderRequests;
    },
    renderWidget: (width = 80) => component?.render(width) ?? widgets.at(-1)?.lines ?? [],
  };
}

export function identityTheme() {
  const calls: [string, string][] = [];
  const theme = {
    fg(role: string, text: string) {
      calls.push(["fg", role]);
      return text;
    },
    bold(text: string) {
      calls.push(["style", "bold"]);
      return text;
    },
    strikethrough(text: string) {
      calls.push(["style", "strikethrough"]);
      return text;
    },
  } as unknown as Theme;
  return { calls, theme };
}

export function progressToolResultMessage(
  details: unknown,
  toolName = TOOL_NAME,
  isError = false,
  toolCallId = "progress-call",
): ContextEvent["messages"][number] {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "updated" }],
    details: details === undefined ? undefined : toJsonValue(details),
    isError,
    timestamp: 0,
  };
}

export function progressToolCallMessage(
  value: unknown,
  toolName = TOOL_NAME,
  argumentName: "steps" | "todos" | "items" = "steps",
  toolCallId = "progress-call",
): ContextEvent["messages"][number] {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        arguments: { [argumentName]: toJsonValue(value) },
      },
    ],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toJsonValue(item);
    }
    return result;
  }
  throw new TypeError("Progress test fixture must be JSON-compatible");
}

export function toolResultEntry(
  details: unknown,
  toolName = TOOL_NAME,
  id = "tool-result",
  parentId: string | null = null,
  isError = false,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    message: progressToolResultMessage(details, toolName, isError, id),
  } as SessionEntry;
}

export function customEntry(customType: string, data: unknown, id: string, parentId: string | null): SessionEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    customType,
    data,
  } as SessionEntry;
}

export async function setProgress(
  harness: ReturnType<typeof createHarness>,
  ctx: ExtensionContext,
  steps: ProgressStep[],
) {
  return harness.tool.execute("progress-call", { steps }, undefined, undefined, ctx);
}
