import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type MenuDefinition, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import type { DiscoveryResult, MarkdownEntry, NotesStorage } from "./storage.js";

interface NotesMenuState {
  notes: DiscoveryResult;
  templates: DiscoveryResult;
}

type NotesScreen = "notes" | "openNote" | "templates" | "pastePath" | "manageTemplates";
type NotesAction = "chooseRoute" | "chooseNote" | "chooseTemplate" | "pastePath" | "editTemplate";

export type NotesManagerResult =
  | { kind: "open"; notePath: string }
  | { kind: "pastePath"; notePath: string }
  | { kind: "editTemplate"; templatePath: string }
  | { kind: "closed" };

export function createNotesMenu(storage: NotesStorage) {
  let result: Exclude<NotesManagerResult, { kind: "closed" }> | undefined;

  const getState = async ({ signal }: { signal: AbortSignal }): Promise<NotesMenuState> => {
    const notes = await storage.discoverNotes(signal);
    if (signal.aborted) throw signal.reason;
    const templates = await storage.discoverTemplates(signal);
    if (signal.aborted) throw signal.reason;
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
            id: "open",
            label: "Open a note…",
            description: "Choose an existing Markdown note.",
            searchText: "open browse existing note",
          },
          {
            id: "create",
            label: "Create a note…",
            description: "Open an automatically named blank note or user template.",
            searchText: "new create blank template automatic filename",
          },
          {
            id: "paste-path",
            label: "Paste a note path…",
            description: "Insert a note's absolute path into the parent editor.",
            searchText: "paste insert absolute path",
          },
          {
            id: "manage-templates",
            label: "Manage templates…",
            description: "Edit existing Markdown templates.",
            searchText: "manage edit templates",
          },
        ],
        action: "chooseRoute",
        viewportSize: 12,
        hint: "close",
      }),
      openNote: ({ state }) => ({
        kind: "choice",
        title: "Open a note",
        lines: discoveryLines(state.notes, "note"),
        items: state.notes.entries.map((note, index) => ({
          id: `note:${index}`,
          label: note.displayPath,
          description: `${note.size} bytes`,
          searchText: note.displayPath,
        })),
        action: "chooseNote",
        enableSearch: state.notes.entries.length > 8,
        viewportSize: 12,
        hint: "back",
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
      pastePath: ({ state }) => ({
        kind: "choice",
        title: "Paste a note path",
        lines: discoveryLines(state.notes, "note"),
        items: state.notes.entries.map((note, index) => ({
          id: `paste:${index}`,
          label: note.displayPath,
          description: `${note.size} bytes`,
          searchText: note.displayPath,
        })),
        action: "pastePath",
        enableSearch: state.notes.entries.length > 8,
        viewportSize: 12,
        hint: "back",
      }),
      manageTemplates: ({ state }) => ({
        kind: "choice",
        title: "Manage templates",
        lines: discoveryLines(state.templates, "template"),
        items: state.templates.entries.map((template, index) => ({
          id: `manage-template:${index}`,
          label: template.displayPath,
          description: `${template.size} bytes`,
          searchText: template.displayPath,
        })),
        action: "editTemplate",
        enableSearch: state.templates.entries.length > 8,
        viewportSize: 12,
        hint: "back",
      }),
    },
    actions: {
      chooseRoute: ({ itemId }) => {
        if (itemId === "open") return { kind: "to", screen: "openNote" };
        if (itemId === "create") return { kind: "to", screen: "templates" };
        if (itemId === "paste-path") return { kind: "to", screen: "pastePath" };
        if (itemId === "manage-templates") return { kind: "to", screen: "manageTemplates" };
        return { kind: "rejected", error: new Error("The selected notes action is no longer available") };
      },
      chooseNote: ({ state, itemId }) => {
        const note = indexedEntry(state.notes.entries, itemId, "note:");
        if (!note) return { kind: "rejected", error: new Error("The selected note is no longer available") };
        result = { kind: "open", notePath: note.relativePath };
        return { kind: "close" };
      },
      chooseTemplate: async ({ state, itemId, signal }) => {
        const templatePath =
          itemId === "blank" ? undefined : indexedEntry(state.templates.entries, itemId, "template:")?.relativePath;
        if (itemId !== "blank" && !templatePath) {
          return { kind: "rejected", error: new Error("The selected template is no longer available") };
        }
        const note = await storage.createAutomaticNote({ ...(templatePath ? { templatePath } : {}), signal });
        if (signal.aborted) return { kind: "close" };
        result = { kind: "open", notePath: note.relativePath };
        return { kind: "close" };
      },
      pastePath: ({ state, itemId }) => {
        const note = indexedEntry(state.notes.entries, itemId, "paste:");
        if (!note) return { kind: "rejected", error: new Error("The selected note is no longer available") };
        result = { kind: "pastePath", notePath: note.relativePath };
        return { kind: "close" };
      },
      editTemplate: ({ state, itemId }) => {
        const template = indexedEntry(state.templates.entries, itemId, "manage-template:");
        if (!template) {
          return { kind: "rejected", error: new Error("The selected template is no longer available") };
        }
        result = { kind: "editTemplate", templatePath: template.relativePath };
        return { kind: "close" };
      },
    },
  };

  return {
    menu,
    getState,
    getResult: () => result,
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
  const selected = controller.getResult();
  return selected && ownership.isCurrent() && !ownership.signal.aborted ? selected : { kind: "closed" };
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
