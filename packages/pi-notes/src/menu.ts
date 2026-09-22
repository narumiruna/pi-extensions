import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type MenuDefinition, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import type { DiscoveryResult, MarkdownEntry, NotesStorage } from "./storage.js";

interface NotesMenuState {
  notes: DiscoveryResult;
  templates: DiscoveryResult;
}

type NotesScreen = "notes" | "templates" | "path";
type NotesAction = "chooseNote" | "chooseTemplate" | "createNote";

export interface NotesManagerResult {
  kind: "open" | "closed";
  notePath?: string;
}

export function createNotesMenu(storage: NotesStorage) {
  let selectedTemplate: string | undefined;
  let selectedNote: string | undefined;

  const getState = async ({ signal }: { signal: AbortSignal }): Promise<NotesMenuState> => {
    const notes = await storage.discoverNotes(signal);
    if (signal.aborted) throw signal.reason;
    const templates = await storage.discoverTemplates(signal);
    return { notes, templates };
  };

  const menu: MenuDefinition<NotesMenuState, NotesScreen, NotesAction> = {
    start: "notes",
    screens: {
      notes: ({ state }) => ({
        kind: "choice",
        title: `Pi Notes · ${state.notes.entries.length} note${state.notes.entries.length === 1 ? "" : "s"}`,
        lines: discoveryLines(state.notes, "note"),
        items: [
          {
            id: "create",
            label: "Create a note…",
            description: "Start blank or copy a user template.",
            searchText: "new create blank template",
          },
          ...state.notes.entries.map((note, index) => ({
            id: `note:${index}`,
            label: note.displayPath,
            description: `${note.size} bytes`,
            searchText: note.displayPath,
          })),
        ],
        action: "chooseNote",
        enableSearch: state.notes.entries.length > 8,
        viewportSize: 12,
        hint: "close",
      }),
      templates: ({ state }) => ({
        kind: "choice",
        title: "Choose initial content",
        lines: discoveryLines(state.templates, "template"),
        items: [
          {
            id: "blank",
            label: "Blank",
            description: "Create an empty Markdown note.",
          },
          ...state.templates.entries.map((template, index) => ({
            id: `template:${index}`,
            label: template.displayPath,
            description: `${template.size} bytes`,
            searchText: template.displayPath,
          })),
        ],
        action: "chooseTemplate",
        enableSearch: state.templates.entries.length > 8,
        viewportSize: 12,
        hint: "back",
      }),
      path: () => ({
        kind: "input",
        title: "New note path",
        lines: [
          "Enter a relative Markdown path below pi-notes/notes.",
          selectedTemplate ? `Template: ${sanitizeTerminalText(selectedTemplate)}` : "Template: Blank",
        ],
        placeholder: "topic.md or folder/topic.md",
        action: "createNote",
        hint: "back",
      }),
    },
    actions: {
      chooseNote: ({ state, itemId }) => {
        if (itemId === "create") return { kind: "to", screen: "templates" };
        const note = indexedEntry(state.notes.entries, itemId, "note:");
        if (!note) return { kind: "rejected", error: new Error("The selected note is no longer available") };
        selectedNote = note.relativePath;
        return { kind: "close" };
      },
      chooseTemplate: ({ state, itemId }) => {
        if (itemId === "blank") {
          selectedTemplate = undefined;
          return { kind: "to", screen: "path" };
        }
        const template = indexedEntry(state.templates.entries, itemId, "template:");
        if (!template) {
          return { kind: "rejected", error: new Error("The selected template is no longer available") };
        }
        selectedTemplate = template.relativePath;
        return { kind: "to", screen: "path" };
      },
      createNote: async ({ value, signal }) => {
        if (typeof value !== "string") return { kind: "rejected", error: new Error("Note path is required") };
        const note = await storage.createNote(value, { templatePath: selectedTemplate, signal });
        if (signal.aborted) return { kind: "close" };
        selectedNote = note.relativePath;
        return { kind: "close" };
      },
    },
  };

  return {
    menu,
    getState,
    getSelectedNote: () => selectedNote,
  };
}

export async function showNotesManager(
  ctx: ExtensionCommandContext,
  storage: NotesStorage,
  ownership: { signal: AbortSignal; isCurrent(): boolean },
): Promise<NotesManagerResult> {
  const controller = createNotesMenu(storage);
  const result = await runMenu(ctx, controller.menu, {
    getState: controller.getState,
    signal: ownership.signal,
    isCurrent: ownership.isCurrent,
    onError: (currentCtx, error) => {
      if (!ownership.signal.aborted && ownership.isCurrent()) {
        safeNotify(currentCtx, `Pi Notes failed: ${safeErrorMessage(error)}`, "error");
      }
    },
  });
  if (result.kind === "error") throw result.error;
  const selected = controller.getSelectedNote();
  return selected && ownership.isCurrent() && !ownership.signal.aborted
    ? { kind: "open", notePath: selected }
    : { kind: "closed" };
}

function indexedEntry(entries: readonly MarkdownEntry[], itemId: string, prefix: string): MarkdownEntry | undefined {
  if (!itemId.startsWith(prefix)) return undefined;
  const index = Number.parseInt(itemId.slice(prefix.length), 10);
  return Number.isSafeInteger(index) && index >= 0 ? entries[index] : undefined;
}

function discoveryLines(result: DiscoveryResult, noun: string): string[] | undefined {
  if (result.errors.length === 0 && !result.limited) {
    return result.entries.length === 0 ? [`No ${noun}s found.`] : undefined;
  }
  const lines = result.errors.slice(0, 3).map((error) => {
    const path = error.relativePath ? `${sanitizeTerminalText(error.relativePath)}: ` : "";
    return `${path}${sanitizeTerminalText(error.message)}`;
  });
  if (result.errors.length > lines.length)
    lines.push(`${result.errors.length - lines.length} more issue(s) not shown.`);
  if (result.limited) lines.push("Discovery reached a safety limit; some entries are not shown.");
  return lines;
}

function safeNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(sanitizeTerminalText(message), level);
  } catch {
    // A replaced parent session must not keep an obsolete command continuation alive.
  }
}

function safeErrorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error));
}
