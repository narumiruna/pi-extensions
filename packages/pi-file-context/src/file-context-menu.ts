import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { RunMenuResult } from "@narumitw/pi-tui-kit";
import { normalizeKeyId } from "./file-context-settings.js";

export interface FileContextMenuQuote {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileContextMenuState {
  quotes: readonly FileContextMenuQuote[];
  shortcut: string | null;
  maximumQuotes: number;
  maximumBytes: number;
  totalBytes: number;
  settingsPath: string;
  settingsInvalidReason?: string;
}

export type FileContextMenuAddResult = "stay" | "close";

export type FileContextMenuRemovalResult =
  | { kind: "removed"; quote: FileContextMenuQuote; remaining: number }
  | { kind: "missing" };

export interface FileContextMenuOptions {
  start?: "main" | "remove";
  signal: AbortSignal;
  isCurrent(): boolean;
  getState(): FileContextMenuState | Promise<FileContextMenuState>;
  addQuote(signal: AbortSignal): FileContextMenuAddResult | Promise<FileContextMenuAddResult>;
  removeQuote(id: string, signal: AbortSignal): FileContextMenuRemovalResult | Promise<FileContextMenuRemovalResult>;
  saveShortcut(shortcut: KeyId | null, signal: AbortSignal): void | Promise<void>;
}

type Screen = "main" | "selected" | "quote" | "settings" | "shortcut" | "status" | "help";
type Action = "add" | "review" | "remove" | "open-shortcut" | "set-shortcut";

export async function showFileContextMenu(
  ctx: ExtensionCommandContext,
  options: FileContextMenuOptions,
): Promise<RunMenuResult> {
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (!options.isCurrent() || options.signal.aborted) return { kind: "stale" };

  let addRequested = false;
  let selectedQuoteId: string | undefined;
  const menu = defineMenu<FileContextMenuState, Screen, Action, ExtensionCommandContext>({
    start: options.start === "remove" ? "selected" : "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "File Context",
        lines: [
          `Next prompt context: ${state.quotes.length}/${state.maximumQuotes} snippets · ~${estimateTokens(state.totalBytes)} tokens`,
          `Shortcut: ${formatShortcut(state.shortcut)}`,
        ],
        items: [
          {
            id: "add",
            label: "Add context snippet",
            description: "Browse project files and select lines",
            action: "add",
            busyLabel: "Scanning project files",
            disabled: addDisabledReason(state) !== undefined,
            disabledReason: addDisabledReason(state),
          },
          {
            id: "selected",
            label: `Review selected context (${state.quotes.length})`,
            description: "Preview exact snapshots before removing them",
            to: "selected",
            disabled: state.quotes.length === 0,
            disabledReason: state.quotes.length === 0 ? "No context selected for the next prompt" : undefined,
          },
          {
            id: "settings",
            label: "Settings",
            description: "Configure the shortcut used to open File Context",
            to: "settings",
            disabled: state.quotes.length > 0,
            disabledReason:
              state.quotes.length > 0
                ? "Submit or remove selected context first; applying a shortcut reloads Pi"
                : undefined,
          },
          {
            id: "status",
            label: "Status",
            description: "Review selected context, limits, and active settings",
            to: "status",
          },
          {
            id: "help",
            label: "Help",
            description: "Review shortcuts and attachment behavior",
            to: "help",
          },
        ],
        hint: "close",
      }),
      selected: ({ state }) =>
        state.quotes.length === 0
          ? {
              kind: "detail",
              title: "Selected context",
              lines: ["No context selected for the next prompt."],
              hint: "back",
            }
          : {
              kind: "choice",
              title: "Selected context",
              lines: [`${state.quotes.length} snippets · Enter reviews the exact snapshot before removal`],
              items: state.quotes.map((quote, index) => ({
                id: quote.id,
                label: `${index + 1}. ${quote.path}`,
                description: `lines ${quote.startLine}-${quote.endLine} · ~${estimateTokens(Buffer.byteLength(quote.text, "utf8"))} tokens`,
                details: [`Lines ${quote.startLine}-${quote.endLine} · Preview: ${singleLinePreview(quote.text)}`],
              })),
              action: "review",
              viewportSize: 8,
              hint: "back",
            },
      quote: ({ state }) => {
        const quote = state.quotes.find((candidate) => candidate.id === selectedQuoteId);
        if (!quote) {
          return {
            kind: "detail",
            title: "Review context snippet",
            lines: ["That snippet is no longer selected. Go back to refresh the list."],
            hint: "back",
          };
        }
        return {
          kind: "review",
          title: "Review context snippet",
          lines: [
            quote.path,
            `Lines ${quote.startLine}-${quote.endLine} · ~${estimateTokens(Buffer.byteLength(quote.text, "utf8"))} tokens`,
          ],
          content: quote.text,
          format: { kind: "text" },
          viewportSize: "adaptive",
          confirm: {
            id: "remove",
            label: "Remove from next prompt",
            action: "remove",
          },
          hint: "back",
        };
      },
      settings: ({ state }) =>
        state.settingsInvalidReason
          ? {
              kind: "detail",
              title: "File Context Settings · Read only",
              lines: [
                `Invalid settings file. Fix ${safeTerminalText(state.settingsPath)} before saving.`,
                safeTerminalText(state.settingsInvalidReason),
              ],
              hint: "back",
            }
          : {
              kind: "settings",
              title: "File Context Settings",
              lines: [
                `User settings · ${safeTerminalText(state.settingsPath)}`,
                "Saving reloads Pi so the new shortcut becomes active.",
              ],
              items: [
                {
                  id: "openShortcut",
                  label: "Open shortcut",
                  description: "Set the global shortcut used to open the file browser.",
                  currentValue: state.shortcut ?? "none",
                  action: "open-shortcut",
                },
              ],
              hint: "back",
            },
      shortcut: ({ state }) => ({
        kind: "input",
        title: "File Context shortcut",
        lines: [
          `Configured: ${state.shortcut ?? "none"}`,
          "Use a Pi key identifier such as ctrl+shift+x or f8.",
          "Submit an empty value to disable the shortcut.",
        ],
        placeholder: state.shortcut ?? "",
        action: "set-shortcut",
        hint: "back",
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "File Context Status",
        lines: [
          `Next prompt context: ${state.quotes.length}/${state.maximumQuotes} snippets`,
          `Estimated context: ~${estimateTokens(state.totalBytes)} tokens · ${state.totalBytes}/${state.maximumBytes} bytes`,
          `Open shortcut: ${state.shortcut ?? "none"}`,
          `User settings: ${safeTerminalText(state.settingsPath)}`,
          ...(state.settingsInvalidReason
            ? [`Settings warning: ${safeTerminalText(state.settingsInvalidReason)}`]
            : []),
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "File Context help",
        lines: [
          "Add context snippet opens the project browser. Select lines and press Enter to add and close, or A to add and keep browsing.",
          "Selected context is attached in order to your next prompt, then cleared together.",
          "Review selected context opens each exact snapshot before offering removal.",
          "The configured shortcut and /file-context browse open the browser directly.",
          "Settings saves the shortcut and reloads Pi; Status shows active limits and configuration.",
          "Escape goes back. Ctrl+C closes File Context. Cancelling never changes selected context.",
        ],
        hint: "back",
      }),
    },
    actions: {
      add: () => {
        addRequested = true;
        return { kind: "close" };
      },
      review: ({ itemId }) => {
        selectedQuoteId = itemId;
        return { kind: "to", screen: "quote" };
      },
      "open-shortcut": async () => ({ kind: "to", screen: "shortcut" }),
      "set-shortcut": async ({ ctx: actionCtx, value, signal }) => {
        const raw = value?.trim() || null;
        const normalized = raw ? normalizeKeyId(raw) : undefined;
        if (raw && !normalized) {
          actionCtx.ui.notify(
            `Invalid key identifier: ${safeTerminalText(raw)}. Use a Pi key identifier like ctrl+shift+x.`,
            "warning",
          );
          return { kind: "stay" };
        }
        const shortcut = normalized ?? null;
        try {
          await options.saveShortcut(shortcut, signal);
        } catch (error: unknown) {
          if (!signal.aborted && options.isCurrent()) {
            actionCtx.ui.notify(
              `Could not save File Context settings; the previous shortcut remains: ${safeTerminalText(formatError(error))}`,
              "error",
            );
          }
          return { kind: "stay" };
        }
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        actionCtx.ui.notify(
          shortcut
            ? `Saved File Context shortcut ${safeTerminalText(shortcut)}. Reloading Pi…`
            : "Disabled the File Context shortcut. Reloading Pi…",
          "info",
        );
        try {
          await actionCtx.reload();
          return { kind: "close" };
        } catch (error: unknown) {
          if (!signal.aborted && options.isCurrent()) {
            actionCtx.ui.notify(
              `File Context settings were saved, but Pi could not reload; run /reload to apply them: ${safeTerminalText(formatError(error))}`,
              "error",
            );
          }
          return { kind: "close" };
        }
      },
      remove: async ({ signal }) => {
        const itemId = selectedQuoteId;
        if (!itemId) return { kind: "back" };
        const result = await options.removeQuote(itemId, signal);
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        if (result.kind === "missing") {
          ctx.ui.notify("That snippet is no longer selected. The list was refreshed.", "warning");
          return { kind: "stay" };
        }
        ctx.ui.notify(
          `Removed from next prompt context: ${safeTerminalText(result.quote.path)} · lines ${result.quote.startLine}-${result.quote.endLine}.`,
          "info",
        );
        selectedQuoteId = undefined;
        return { kind: "back" };
      },
    },
  });

  while (options.isCurrent() && !options.signal.aborted) {
    addRequested = false;
    const result = await runMenu(ctx, menu, {
      getState: () => options.getState(),
      signal: options.signal,
      isCurrent: options.isCurrent,
      onError: (_menuContext, error) => {
        ctx.ui.notify(
          `File Context menu failed: ${safeTerminalText(formatError(error))}. Selected context was kept; try again.`,
          "error",
        );
      },
      onUnsupportedMode: (_menuContext, mode) => {
        ctx.ui.notify(`File Context is unavailable in ${mode} mode.`, "warning");
      },
    });
    if (!addRequested || result.kind !== "closed") return result;
    const addResult = await options.addQuote(options.signal);
    if (!options.isCurrent() || options.signal.aborted) return { kind: "stale" };
    if (addResult === "close") return { kind: "closed", reason: "close" };
  }
  return { kind: "stale" };
}

function addDisabledReason(state: FileContextMenuState): string | undefined {
  if (state.quotes.length >= state.maximumQuotes) {
    return `The ${state.maximumQuotes}-snippet limit is reached; review selected context first`;
  }
  if (state.totalBytes >= state.maximumBytes) {
    return `The ${formatBytes(state.maximumBytes)} context limit is reached; review selected context first`;
  }
  return undefined;
}

function formatShortcut(shortcut: string | null): string {
  return shortcut ? shortcut.toUpperCase() : "Disabled (use /file-context browse)";
}

function singleLinePreview(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").join(" ↵ ");
  const characters = [...normalized];
  if (characters.length === 0) return "(empty)";
  return characters.length <= 200 ? normalized : `${characters.slice(0, 199).join("")}…`;
}

function estimateTokens(bytes: number): number {
  return bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / 4));
}

function formatBytes(bytes: number): string {
  return bytes % 1_000 === 0 ? `${bytes / 1_000} KB` : `${bytes} bytes`;
}

function safeTerminalText(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) ? `\\x${code.toString(16).padStart(2, "0")}` : character;
    })
    .join("");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
