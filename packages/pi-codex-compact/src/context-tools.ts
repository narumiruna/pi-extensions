import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadContextLineage } from "./context-window.js";
import { createNoteMutation, NOTES_ENTRY_TYPE } from "./notes-state.js";
import { recallContext } from "./recall-context.js";
import { terminalText } from "./terminal.js";

export const EXPERIMENTAL_CONTEXT_TOOL_NAMES = [
  "codex_compact_start_new_context",
  "codex_compact_get_context_remaining",
  "codex_compact_recall_context",
  "codex_compact_update_notes",
] as const;

export const EXPERIMENTAL_CONTEXT_TOOL_DESCRIPTIONS = {
  codex_compact_start_new_context:
    "Request a fresh summary-free context window after the current agent run settles. Save important durable information with codex_compact_update_notes first. This tool changes context state but does not read or write memory itself.",
  codex_compact_get_context_remaining:
    "Inspect the active model context window and estimated remaining tokens without changing context state.",
  codex_compact_recall_context:
    "Read-only access to branch-local conversation history or context notes. List items, read one stable item ID, or search text. Use the returned cursor to continue bounded results.",
  codex_compact_update_notes:
    "Write or append one branch-local context note. This tool changes notes only; use codex_compact_recall_context with source notes to read them.",
} as const satisfies Record<(typeof EXPERIMENTAL_CONTEXT_TOOL_NAMES)[number], string>;

const RECALL_SOURCES = ["history", "notes"] as const;
const RECALL_ACTIONS = ["list", "read", "search"] as const;
const NOTE_ACTIONS = ["write", "append"] as const;

export interface ContextToolRuntime {
  isEnabled(): boolean;
  requestNewContext(
    ctx: ExtensionContext,
    input: { toolCallId: string; reason?: string },
  ): { requestId: string; currentWindowId: string };
}

function requireEnabled(runtime: ContextToolRuntime): void {
  if (!runtime.isEnabled()) {
    throw new Error("Experimental context management is disabled; enable it in pi-codex-compact settings first");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Context tool operation aborted", "AbortError");
}

function result(value: unknown, details?: unknown) {
  return {
    content: [{ type: "text" as const, text: terminalText(JSON.stringify(value, null, 2)) }],
    details,
  };
}

export function registerExperimentalContextTools(pi: ExtensionAPI, runtime: ContextToolRuntime): void {
  pi.registerTool({
    name: "codex_compact_start_new_context",
    label: "Start New Context",
    description: EXPERIMENTAL_CONTEXT_TOOL_DESCRIPTIONS.codex_compact_start_new_context,
    parameters: Type.Object(
      {
        reason: Type.Optional(
          Type.String({
            description: "Short reason for starting a fresh context window",
            maxLength: 512,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      requireEnabled(runtime);
      throwIfAborted(signal);
      const requested = runtime.requestNewContext(ctx, {
        toolCallId,
        ...(params.reason ? { reason: params.reason } : {}),
      });
      throwIfAborted(signal);
      return {
        ...result(
          {
            status: "scheduled",
            requestId: requested.requestId,
            currentWindowId: requested.currentWindowId,
            message:
              "The current run will end before rollover. A hidden continuation starts after compaction succeeds.",
          },
          { ...requested, status: "scheduled" },
        ),
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "codex_compact_get_context_remaining",
    label: "Get Context Remaining",
    description: EXPERIMENTAL_CONTEXT_TOOL_DESCRIPTIONS.codex_compact_get_context_remaining,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      requireEnabled(runtime);
      throwIfAborted(signal);
      const usage = ctx.getContextUsage();
      const lineage = loadContextLineage(ctx.sessionManager.getBranch());
      if (!usage) {
        return result({
          available: false,
          ...(lineage ? { currentWindowId: lineage.currentWindowId } : {}),
        });
      }
      const remainingTokens = usage.tokens === null ? null : Math.max(0, usage.contextWindow - usage.tokens);
      return result({
        available: usage.tokens !== null,
        ...(lineage ? { currentWindowId: lineage.currentWindowId } : {}),
        contextWindow: usage.contextWindow,
        usedTokens: usage.tokens,
        remainingTokens,
        remainingPercent: usage.percent === null ? null : Math.max(0, 100 - usage.percent),
      });
    },
  });

  pi.registerTool({
    name: "codex_compact_recall_context",
    label: "Recall Context",
    description: EXPERIMENTAL_CONTEXT_TOOL_DESCRIPTIONS.codex_compact_recall_context,
    parameters: Type.Object(
      {
        source: StringEnum(RECALL_SOURCES, {
          description: "Read conversation history or context notes",
        }),
        action: StringEnum(RECALL_ACTIONS, {
          description: "List items, read one ID, or search text",
        }),
        id: Type.Optional(Type.String({ description: "Stable history item ID or note name", maxLength: 256 })),
        query: Type.Optional(Type.String({ description: "Case-insensitive search text", maxLength: 512 })),
        cursor: Type.Optional(Type.String({ description: "Cursor returned by an earlier result", maxLength: 12 })),
      },
      { additionalProperties: false },
    ),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      requireEnabled(runtime);
      throwIfAborted(signal);
      const recalled = recallContext(ctx.sessionManager.getBranch(), params, toolCallId);
      throwIfAborted(signal);
      return {
        content: [{ type: "text", text: recalled.text }],
        details: recalled.details,
      };
    },
  });

  pi.registerTool({
    name: "codex_compact_update_notes",
    label: "Update Context Notes",
    description: EXPERIMENTAL_CONTEXT_TOOL_DESCRIPTIONS.codex_compact_update_notes,
    parameters: Type.Object(
      {
        action: StringEnum(NOTE_ACTIONS, {
          description: "Replace a note or append content exactly as supplied",
        }),
        note: Type.String({ description: "Note name", minLength: 1, maxLength: 128 }),
        content: Type.String({
          description: "Note content written or appended exactly as supplied",
          minLength: 1,
          maxLength: 16_384,
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireEnabled(runtime);
      throwIfAborted(signal);
      const updated = createNoteMutation(ctx.sessionManager.getBranch(), params);
      throwIfAborted(signal);
      pi.appendEntry(NOTES_ENTRY_TYPE, updated.mutation);
      return result(
        {
          status: "updated",
          action: updated.mutation.action,
          note: updated.mutation.note,
          bytes: Buffer.byteLength(updated.notes.get(updated.mutation.note) ?? "", "utf8"),
        },
        {
          version: updated.mutation.version,
          action: updated.mutation.action,
          note: updated.mutation.note,
        },
      );
    },
  });
}
