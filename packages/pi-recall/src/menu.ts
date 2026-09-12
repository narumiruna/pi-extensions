import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition } from "@narumitw/pi-tui-kit";
import {
  candidateIdentity,
  filterRecallMessages,
  formatRecallQuote,
  type MessageCandidate,
  messagePreview,
  type RecallMessageRecord,
  type RecallScope,
  type RecallScopeContext,
} from "./messages.js";
import { type RecallView, ScopedRecallPicker, type ScopedRecallPickerResult, sanitizeTerminalText } from "./picker.js";
import { MAX_RECALL_FILE_BYTES, MAX_RECALL_RECORDS, type RecallStoreSnapshot } from "./store.js";

export interface RecallMenuSource {
  path: string;
  current: RecallScopeContext;
  candidates: readonly MessageCandidate[];
  load(signal?: AbortSignal): Promise<RecallStoreSnapshot>;
  save(candidate: MessageCandidate, signal?: AbortSignal): Promise<RecallMessageRecord>;
  delete(id: string, signal?: AbortSignal): Promise<boolean>;
}

interface RecallMenuState {
  path: string;
  current: RecallScopeContext;
  candidates: readonly MessageCandidate[];
  records: readonly RecallMessageRecord[];
  bytes: number;
  error?: string;
  selected?: RecallMessageRecord;
}

type Screen = "main" | "save" | "selected" | "preview" | "delete" | "status" | "help";
type Action = "saveMessage" | "chooseSaved" | "quote" | "deleteMessage";

const SCOPE_LABELS: Record<RecallScope, string> = {
  cwd: "Current cwd",
  all: "All",
  session: "Current session",
};

export function createRecallMenu(source: RecallMenuSource, ownership: { isCurrent?: () => boolean } = {}) {
  let selectedRecordId: string | undefined;
  let selectedScope: RecallScope = "cwd";
  let selectedView: RecallView = "all";
  let pickerSelectedId: string | undefined;
  let pickerQuery = "";

  const getState = async ({ signal }: { signal: AbortSignal }): Promise<RecallMenuState> => {
    try {
      const snapshot = await source.load(signal);
      return {
        path: source.path,
        current: source.current,
        candidates: source.candidates,
        records: snapshot.records,
        bytes: snapshot.bytes,
        selected: snapshot.records.find(({ id }) => id === selectedRecordId),
      };
    } catch (error) {
      return {
        path: source.path,
        current: source.current,
        candidates: source.candidates,
        records: [],
        bytes: 0,
        error: safeErrorMessage(error),
      };
    }
  };

  const menu: MenuDefinition<RecallMenuState, Screen, Action> = {
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: `Pi Recall · ${state.records.length} saved`,
        lines: state.error
          ? [`Storage unavailable: ${state.error}`, "Existing storage remains read-only."]
          : state.records.length === 0
            ? ["No saved messages yet."]
            : undefined,
        items: [
          { id: "save", label: "Save a message", to: "save", disabled: Boolean(state.error) },
          {
            id: "recall",
            label: "Recall a saved message",
            action: "chooseSaved",
            disabled: Boolean(state.error),
          },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      save: ({ state }) => saveScreen(state),
      selected: ({ state }) => selectedScreen(state),
      preview: ({ state }) => ({
        kind: "review",
        title: "Saved message preview",
        lines: state.selected ? sourceLines(state.selected) : ["The saved message is no longer available."],
        content: state.selected?.text ?? "",
        format: { kind: "text" },
        viewportSize: "adaptive",
        hint: "back",
      }),
      delete: ({ state }) => ({
        kind: "review",
        title: "Delete saved message?",
        lines: state.selected
          ? [
              ...sourceLines(state.selected),
              "This removes the record from canonical JSONL but is not secure filesystem erasure.",
            ]
          : ["The saved message is no longer available."],
        content: state.selected?.text ?? "",
        format: { kind: "text" },
        viewportSize: "adaptive",
        ...(state.selected
          ? {
              confirm: {
                id: "delete-confirm",
                label: "Delete saved message",
                action: "deleteMessage" as const,
              },
            }
          : {}),
        hint: "back",
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Pi Recall status",
        lines: [
          `Storage: ${state.path}`,
          `Saved messages: ${state.records.length} / ${MAX_RECALL_RECORDS}`,
          `Storage bytes: ${state.bytes} / ${MAX_RECALL_FILE_BYTES}`,
          `State: ${state.error ? `read-only · ${state.error}` : "ready"}`,
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Pi Recall help",
        lines: [
          "Save captures one text user or assistant message from the active session branch.",
          "Recall defaults to Current cwd. In TUI, Tab and Shift+Tab change scope.",
          "Quote inserts an XML-marked excerpt into the draft and never submits it automatically.",
          "Saved content stays local until you submit a quoted draft.",
        ],
        hint: "back",
      }),
    },
    actions: {
      saveMessage: async ({ ctx, state, signal, itemId }) => {
        const candidate = state.candidates.find(({ entryId }) => entryId === itemId);
        if (!candidate) return { kind: "rejected", error: new Error("Message is unavailable") };
        await source.save(candidate, signal);
        if (!signal.aborted && isCurrent(ownership)) {
          safeNotify(ctx, "Saved message to Pi Recall.", "info");
        }
        return signal.aborted || !isCurrent(ownership) ? { kind: "close" } : { kind: "to", screen: "main" };
      },
      chooseSaved: async ({ ctx, state, signal }) => {
        if (ctx.mode === "tui") {
          let availableRecords = [...state.records];
          while (!signal.aborted && isCurrent(ownership)) {
            const result = await chooseSavedInTui(
              ctx,
              { ...state, records: availableRecords },
              signal,
              ownership,
              selectedScope,
              selectedView,
              pickerSelectedId,
              pickerQuery,
            );
            if (signal.aborted || !isCurrent(ownership)) return { kind: "close" };
            if (!result) return { kind: "stay" };
            selectedScope = result.scope;
            selectedView = result.view;
            pickerQuery = result.query ?? pickerQuery;
            if ("selectedId" in result) pickerSelectedId = result.selectedId;
            if (result.kind === "back") return { kind: "stay" };
            if (result.kind === "close") return { kind: "close" };
            if (result.kind === "delete") {
              pickerSelectedId = result.recordId;
              const record = availableRecords.find(({ id }) => id === result.recordId);
              if (!record) {
                pickerSelectedId = result.nextSelectedId;
                continue;
              }
              const confirmed = await ctx.ui.confirm("Delete saved message?", deleteConfirmationMessage(record), {
                signal,
              });
              if (signal.aborted || !isCurrent(ownership)) return { kind: "close" };
              if (!confirmed) continue;
              const { runTask } = await import("@narumitw/pi-tui-kit");
              if (signal.aborted || !isCurrent(ownership)) return { kind: "close" };
              const deletion = await runTask(ctx, {
                label: "Deleting saved message…",
                signal,
                isCurrent: () => isCurrent(ownership),
                cancellable: false,
                task: ({ signal: taskSignal }) => source.delete(record.id, taskSignal),
                onError: (currentCtx, error) => {
                  safeNotify(
                    currentCtx,
                    `Couldn't delete saved message: ${safeErrorMessage(error)}. Retry or check Status.`,
                    "error",
                  );
                },
              });
              if (signal.aborted || !isCurrent(ownership) || deletion.kind === "stale") {
                return { kind: "close" };
              }
              if (deletion.kind === "cancelled" || deletion.kind === "error") continue;
              availableRecords = availableRecords.filter(({ id }) => id !== record.id);
              pickerSelectedId = result.nextSelectedId;
              safeNotify(
                ctx,
                deletion.value
                  ? "Deleted saved message from Pi Recall."
                  : "Saved message was already removed; refreshed Pi Recall.",
                deletion.value ? "info" : "warning",
              );
              continue;
            }
            pickerSelectedId = result.recordId;
            selectedRecordId = result.recordId;
            return { kind: "to", screen: "selected" };
          }
          return { kind: "close" };
        }

        const result = await chooseSavedInRpc(ctx, state, signal, selectedScope);
        if (signal.aborted || !isCurrent(ownership)) return { kind: "close" };
        if (!result || result.kind === "back") return { kind: "stay" };
        if (result.kind === "close") return { kind: "close" };
        selectedScope = result.scope;
        selectedView = result.view;
        pickerSelectedId = result.recordId;
        selectedRecordId = result.recordId;
        return { kind: "to", screen: "selected" };
      },
      quote: ({ ctx, state }) => {
        if (!state.selected) return { kind: "rejected", error: new Error("Saved message is unavailable") };
        ctx.ui.pasteToEditor(formatRecallQuote(state.selected));
        return { kind: "close" };
      },
      deleteMessage: async ({ ctx, state, signal }) => {
        if (!state.selected) return { kind: "back" };
        const deleted = await source.delete(state.selected.id, signal);
        if (deleted && !signal.aborted && isCurrent(ownership)) {
          safeNotify(ctx, "Deleted saved message from Pi Recall.", "info");
        }
        selectedRecordId = undefined;
        pickerSelectedId = undefined;
        return signal.aborted || !isCurrent(ownership) ? { kind: "close" } : { kind: "to", screen: "main" };
      },
    },
  };

  return {
    menu,
    getState,
    selectRecordForTest(id: string) {
      selectedRecordId = id;
    },
  };
}

export async function showRecallMenu(
  ctx: ExtensionCommandContext,
  source: RecallMenuSource,
  ownership: { signal: AbortSignal; isCurrent: () => boolean },
): Promise<void> {
  const { runMenu } = await import("@narumitw/pi-tui-kit");
  if (ownership.signal.aborted || !ownership.isCurrent()) return;
  const controller = createRecallMenu(source, ownership);
  await runMenu(ctx, controller.menu, {
    getState: controller.getState,
    signal: ownership.signal,
    isCurrent: ownership.isCurrent,
    onError: (_ctx, error) => {
      if (ownership.isCurrent() && !ownership.signal.aborted) {
        safeNotify(ctx, `Pi Recall failed: ${safeErrorMessage(error)}`, "error");
      }
    },
  });
}

function saveScreen(state: RecallMenuState) {
  const saved = new Set(
    state.records.map((record) => candidateIdentity(record.source.sessionId, record.source.entryId)),
  );
  return {
    kind: "choice" as const,
    title: "Save a message",
    lines:
      state.candidates.length === 0
        ? ["No eligible text user or assistant messages are on the active branch."]
        : ["Choose one message from the active session branch."],
    items: state.candidates.map((candidate) => {
      const duplicate = saved.has(candidateIdentity(candidate.source.sessionId, candidate.entryId));
      return {
        id: candidate.entryId,
        label: `${candidate.role} · ${new Date(candidate.messageTimestamp).toISOString()}`,
        description: sanitizeTerminalText(messagePreview(candidate.text)),
        details: [sanitizeTerminalText(messagePreview(candidate.text, 200))],
        ...(duplicate ? { disabled: true, disabledReason: "This message is already saved" } : {}),
      };
    }),
    action: "saveMessage" as const,
    viewportSize: 10,
    hint: "back" as const,
  };
}

function selectedScreen(state: RecallMenuState) {
  return {
    kind: "actions" as const,
    title: "Saved message",
    lines: state.selected
      ? [...sourceLines(state.selected), sanitizeTerminalText(messagePreview(state.selected.text, 200))]
      : ["The saved message is no longer available."],
    items: state.selected
      ? [
          { id: "preview", label: "Preview", to: "preview" as const },
          { id: "quote", label: "Quote into draft", action: "quote" as const },
          { id: "delete", label: "Delete…", to: "delete" as const },
          {
            id: "back-to-saved",
            label: "Back to saved messages",
            action: "chooseSaved" as const,
          },
        ]
      : [{ id: "back-to-saved", label: "Back to saved messages", action: "chooseSaved" as const }],
    hint: "back" as const,
  };
}

async function chooseSavedInTui(
  ctx: ExtensionCommandContext,
  state: RecallMenuState,
  signal: AbortSignal,
  ownership: { isCurrent?: () => boolean },
  initialScope: RecallScope,
  initialView: RecallView,
  initialSelectedId: string | undefined,
  initialQuery: string,
): Promise<ScopedRecallPickerResult | undefined> {
  const { runCustomInteraction } = await import("@narumitw/pi-tui-kit");
  if (signal.aborted || !isCurrent(ownership)) return undefined;
  const interaction = await runCustomInteraction<ScopedRecallPickerResult>(ctx, {
    signal,
    isCurrent: () => isCurrent(ownership),
    create: ({ tui, theme, keybindings, complete }) =>
      new ScopedRecallPicker({
        tui,
        theme,
        keybindings,
        records: state.records,
        current: state.current,
        initialScope,
        initialView,
        initialSelectedId,
        initialQuery,
        complete,
      }),
  });
  return interaction.kind === "completed" ? interaction.value : undefined;
}

async function chooseSavedInRpc(
  ctx: ExtensionCommandContext,
  state: RecallMenuState,
  signal: AbortSignal,
  initialScope: RecallScope,
): Promise<ScopedRecallPickerResult | undefined> {
  const scopeOptions = ["Current cwd", "All", "Current session", "Back"];
  const initialLabel = SCOPE_LABELS[initialScope];
  const orderedOptions = [initialLabel, ...scopeOptions.filter((option) => option !== initialLabel)];
  const selectedScopeLabel = await ctx.ui.select("Choose scope", orderedOptions, { signal });
  if (signal.aborted) return undefined;
  if (!selectedScopeLabel || selectedScopeLabel === "Back") {
    return { kind: "back", scope: initialScope, view: "all" };
  }
  const scope = Object.entries(SCOPE_LABELS).find(([, label]) => label === selectedScopeLabel)?.[0] as
    | RecallScope
    | undefined;
  if (!scope) return { kind: "back", scope: initialScope, view: "all" };
  const records = filterRecallMessages(state.records, scope, state.current).reverse();
  if (records.length === 0) {
    safeNotify(ctx, `No saved messages in ${SCOPE_LABELS[scope]}.`, "info");
    return { kind: "back", scope, view: "all" };
  }
  const labels = records.map(
    (record, index) =>
      `${index + 1}. ${record.role} · ${new Date(record.source.messageTimestamp).toISOString()} · ${sanitizeTerminalText(messagePreview(record.text, 72))}`,
  );
  const choice = await ctx.ui.select("Choose saved message", [...labels, "Back"], { signal });
  if (signal.aborted) return undefined;
  if (!choice || choice === "Back") return { kind: "back", scope, view: "all" };
  const index = labels.indexOf(choice);
  const record = records[index];
  return record
    ? { kind: "selected" as const, recordId: record.id, scope, view: "all" }
    : { kind: "back", scope, view: "all" };
}

function deleteConfirmationMessage(record: RecallMessageRecord): string {
  return [
    ...sourceLines(record),
    "",
    `Message preview: ${sanitizeTerminalText(messagePreview(record.text, 400))}`,
    "",
    "Delete this entire saved message? This cannot be undone from Pi Recall.",
  ].join("\n");
}

function sourceLines(record: RecallMessageRecord): string[] {
  return [
    `Role: ${record.role}`,
    `Message time: ${new Date(record.source.messageTimestamp).toISOString()}`,
    `Saved: ${record.savedAt}`,
    `Session: ${sanitizeTerminalText(record.source.sessionName ?? "unnamed")}`,
    `Source cwd: ${sanitizeTerminalText(record.source.cwd)}`,
  ];
}

function isCurrent(ownership: { isCurrent?: () => boolean }): boolean {
  return ownership.isCurrent?.() ?? true;
}

function safeNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(sanitizeTerminalText(message), level);
  } catch {
    // A replaced session can invalidate its UI after a committed storage operation.
  }
}

function safeErrorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error));
}
