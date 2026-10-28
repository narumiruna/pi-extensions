import { resolve } from "node:path";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { settingsChatDisplayValue } from "./settings-chat-display.js";

type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
interface ToolRow {
  name: string;
  args: Record<string, unknown>;
  component?: ToolExecutionComponent;
  complete: boolean;
  started: boolean;
  result?: ToolResult;
  partial: boolean;
  historyResult?: AgentMessage;
  expanded?: boolean;
}

/** Follow Pi's message and tool execution branches with native built-in renderers. */
export function createSettingsChatTools(tui: TUI, cwd: string, initialExpanded: boolean, editablePath?: string) {
  const rows = new Map<string, ToolRow>();
  const pending = new Set<string>();
  const edit = createEditToolDefinition(cwd);
  const renderEditCall = edit.renderCall;
  if (renderEditCall) {
    edit.renderCall = (args, theme, context) => {
      const path =
        typeof args?.path === "string" ? args.path : args && "file_path" in args ? args.file_path : undefined;
      const allowed =
        editablePath !== undefined && typeof path === "string" && resolve(cwd, path) === resolve(editablePath);
      // Native previews read the target before tool execution. Do not let that
      // display-only read bypass this chat's draft-only edit permission.
      return renderEditCall(args, theme, { ...context, argsComplete: context.argsComplete && allowed });
    };
  }
  const definitions = {
    read: createReadToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    edit,
  };
  let disposed = false;
  let expanded = initialExpanded;
  const ensure = (id: string, name: string, args: Record<string, unknown>) => {
    let row = rows.get(id);
    if (!row) {
      row = { name, args, complete: false, started: false, partial: true };
      rows.set(id, row);
    }
    if (!row.component) {
      const toolName = row.name;
      const definition =
        toolName === "read" || toolName === "write" || toolName === "edit" ? definitions[toolName] : undefined;
      const ownedRow = row;
      const toolUi = new Proxy(tui, {
        get(target, property) {
          if (property === "requestRender")
            return () => {
              // Pi's edit-preview read has no cancellation API. Its late completion
              // can invalidate its old component, but must not redraw a closed chat.
              if (!disposed && rows.get(id) === ownedRow && ownedRow.component === component) target.requestRender();
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      // Native result clicks call setExpanded(). Keep that local preference
      // when themed components are rebuilt, without reading private Pi state.
      const Component = class extends ToolExecutionComponent {
        override setExpanded(value: boolean) {
          ownedRow.expanded = value;
          super.setExpanded(value);
        }
      };
      const component = new Component(
        sanitizeTerminalDocument(toolName),
        sanitizeTerminalDocument(id),
        settingsChatDisplayValue(row.args),
        { showImages: false, outputPad: 1 },
        definition,
        toolUi,
        sanitizeTerminalDocument(cwd),
      );
      row.component = component;
      component.setExpanded(row.expanded ?? expanded);
      // Historical final results already contain the authoritative edit diff.
      // Do not reread a mutated file to compute another preview after a rebuild.
      if (row.complete && (!row.result || row.partial)) component.setArgsComplete();
      if (row.started) component.markExecutionStarted();
      if (row.result) component.updateResult(settingsChatDisplayValue(row.result), row.partial);
    }
    return row;
  };
  const updateArgs = (call: ToolCall) => {
    const row = ensure(call.id, call.name, call.arguments);
    row.args = call.arguments;
    row.component?.updateArgs(settingsChatDisplayValue(call.arguments));
    return row;
  };
  const completeArgs = (row: ToolRow) => {
    if (row.complete) return;
    row.complete = true;
    row.component?.setArgsComplete();
  };
  const result = (row: ToolRow, value: ToolResult, partial = false) => {
    row.result = value;
    row.partial = partial;
    row.component?.updateResult(settingsChatDisplayValue(value), partial);
  };
  const failure = (message: AssistantMessage): ToolResult => ({
    content: [
      { type: "text", text: message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error" },
    ],
    isError: true,
  });
  return {
    onEvent(event: AgentEvent) {
      if (disposed) return;
      if (event.type === "message_update" && event.message.role === "assistant") {
        for (const call of event.message.content) {
          if (call.type !== "toolCall") continue;
          updateArgs(call);
          pending.add(call.id);
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const failed = event.message.stopReason === "aborted" || event.message.stopReason === "error";
        // A provider can finalize tool calls without an intermediate update.
        for (const call of event.message.content) {
          if (call.type !== "toolCall") continue;
          updateArgs(call);
          pending.add(call.id);
        }
        for (const id of pending) {
          const row = rows.get(id);
          if (!row) continue;
          if (failed) result(row, failure(event.message));
          else completeArgs(row);
        }
        if (failed) pending.clear();
      }
      if (event.type === "tool_execution_start" && !("parentToolCallId" in event && event.parentToolCallId)) {
        const row = ensure(event.toolCallId, event.toolName, event.args);
        pending.add(event.toolCallId);
        row.started = true;
        row.component?.markExecutionStarted();
      }
      if (event.type === "tool_execution_update") {
        const row = pending.has(event.toolCallId) ? rows.get(event.toolCallId) : undefined;
        if (row) result(row, { ...event.partialResult, isError: false }, true);
      }
      if (event.type === "tool_execution_end") {
        const row = pending.has(event.toolCallId) ? rows.get(event.toolCallId) : undefined;
        if (row) result(row, { ...event.result, isError: event.isError, durationMs: event.durationMs });
        pending.delete(event.toolCallId);
      }
      if (event.type === "agent_end") pending.clear();
    },
    render(call: ToolCall, message: AssistantMessage, historyResult: ToolResultMessage | undefined, width: number) {
      const row = ensure(call.id, call.name, call.arguments);
      if (historyResult && row.historyResult !== historyResult) {
        row.historyResult = historyResult;
        result(row, historyResult);
      }
      if (!historyResult && !row.result && (message.stopReason === "aborted" || message.stopReason === "error"))
        result(row, failure(message));
      return row.component?.render(width) ?? [];
    },
    handleMouse(id: string, event: TuiMouseEvent) {
      if (disposed) return undefined;
      return rows.get(id)?.component?.handleMouse(event);
    },
    retain(ids: Set<string>) {
      for (const id of rows.keys())
        if (!ids.has(id)) {
          rows.delete(id);
          pending.delete(id);
        }
    },
    toggle() {
      if (!disposed) {
        expanded = !expanded;
        for (const row of rows.values()) {
          row.expanded = expanded;
          row.component?.setExpanded(expanded);
        }
        tui.requestRender();
      }
      return expanded;
    },
    invalidate() {
      for (const row of rows.values()) row.component = undefined;
    },
    dispose() {
      disposed = true;
      pending.clear();
      rows.clear();
    },
  };
}
