import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunMenuResult } from "@narumitw/pi-tui-kit";

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

type ReviewState = Pick<FileContextMenuState, "quotes">;

export type FileContextMenuRemovalResult =
  | { kind: "removed"; quote: FileContextMenuQuote; remaining: number }
  | { kind: "missing" };

export interface FileContextMenuOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  getState(): ReviewState | Promise<ReviewState>;
  removeQuote(id: string, signal: AbortSignal): FileContextMenuRemovalResult | Promise<FileContextMenuRemovalResult>;
}

type Screen = "selected" | "quote";
type Action = "review" | "remove";

export async function showFileContextMenu(
  ctx: ExtensionCommandContext,
  options: FileContextMenuOptions,
): Promise<RunMenuResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/files requires Pi TUI mode");
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (!options.isCurrent() || options.signal.aborted) return { kind: "stale" };

  let selectedQuoteId: string | undefined;
  const menu = defineMenu<ReviewState, Screen, Action, ExtensionCommandContext>({
    start: "selected",
    screens: {
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
    },
    actions: {
      review: ({ itemId }) => {
        selectedQuoteId = itemId;
        return { kind: "to", screen: "quote" };
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

  return runMenu(ctx, menu, {
    getState: () => options.getState(),
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: (_menuContext, error) => {
      ctx.ui.notify(
        `File Context menu failed: ${safeTerminalText(formatError(error))}. Selected context was kept; try again.`,
        "error",
      );
    },
  });
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
