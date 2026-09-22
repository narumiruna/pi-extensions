import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type MenuDefinition, runCustomInteraction, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { NotePicker, type NotePickerResult } from "./note-picker.js";
import type { DiscoveryResult, MarkdownEntry, NoteSnapshot, NotesStorage } from "./storage.js";

interface NotesMenuState {
  notes: DiscoveryResult;
  templates: DiscoveryResult;
}

type NotesScreen = "notes" | "templates" | "pastePath" | "manageTemplates";
type NotesAction = "chooseRoute" | "chooseTemplate" | "pastePath" | "editTemplate";

export type NotesManagerResult =
  | { kind: "open"; notePath: string }
  | { kind: "pastePath"; notePath: string }
  | { kind: "editTemplate"; templatePath: string }
  | { kind: "closed" };

export function createNotesMenu(storage: NotesStorage, ownership: { isCurrent?: () => boolean } = {}) {
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
      chooseRoute: async ({ ctx, itemId, signal }) => {
        if (itemId === "open") {
          const selected = await chooseOpenNote(ctx, storage, signal, ownership);
          if (selected.kind === "open") {
            result = selected;
            return { kind: "close" };
          }
          return { kind: selected.kind === "close" ? "close" : "stay" };
        }
        if (itemId === "create") return { kind: "to", screen: "templates" };
        if (itemId === "paste-path") return { kind: "to", screen: "pastePath" };
        if (itemId === "manage-templates") return { kind: "to", screen: "manageTemplates" };
        return { kind: "rejected", error: new Error("The selected notes action is no longer available") };
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
  const controller = createNotesMenu(storage, ownership);
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

async function chooseOpenNote(
  ctx: ExtensionCommandContext,
  storage: NotesStorage,
  signal: AbortSignal,
  ownership: { isCurrent?: () => boolean },
): Promise<{ kind: "open"; notePath: string } | { kind: "back" | "close" }> {
  let selectedPath: string | undefined;
  let query = "";
  const isCurrent = () => ownership.isCurrent?.() ?? true;

  while (!signal.aborted && isCurrent()) {
    const notes = await storage.discoverNotes(signal);
    if (signal.aborted || !isCurrent()) return { kind: "close" };
    const interaction = await runCustomInteraction<NotePickerResult>(ctx, {
      signal,
      isCurrent,
      onError: (currentCtx, error) => {
        if (!signal.aborted && isCurrent()) {
          safeNotify(currentCtx, `Pi Notes picker failed: ${safeErrorMessage(error)}`, "error");
        }
      },
      create: ({ tui, theme, keybindings, complete }) =>
        new NotePicker({
          tui,
          theme,
          keybindings,
          notes: notes.entries,
          lines: discoveryLines(notes, "note"),
          initialSelectedPath: selectedPath,
          initialQuery: query,
          complete,
        }),
    });
    if (signal.aborted || !isCurrent() || interaction.kind === "stale") return { kind: "close" };
    if (interaction.kind !== "completed") return { kind: "close" };

    const choice = interaction.value;
    if ("query" in choice && choice.query !== undefined) query = choice.query;
    if ("selectedPath" in choice) selectedPath = choice.selectedPath;
    if (choice.kind === "back" || choice.kind === "close") return { kind: choice.kind };
    if (choice.kind === "open") return { kind: "open", notePath: choice.notePath };

    selectedPath = choice.nextSelectedPath;
    const selected = notes.entries.find(({ relativePath }) => relativePath === choice.notePath);
    if (!selected) {
      safeNotify(ctx, "The selected note is no longer available; refreshed the note list.", "warning");
      continue;
    }

    let snapshot: NoteSnapshot;
    try {
      snapshot = await storage.readNote(selected.relativePath, signal);
    } catch (error) {
      if (signal.aborted || !isCurrent()) return { kind: "close" };
      safeNotify(ctx, `Pi Notes failed to read the selected note: ${safeErrorMessage(error)}`, "error");
      continue;
    }
    if (signal.aborted || !isCurrent()) return { kind: "close" };

    let confirmed: boolean;
    try {
      confirmed = await ctx.ui.confirm("Delete note?", deleteConfirmationMessage(selected, snapshot.size), {
        signal,
      });
    } catch (error) {
      if (signal.aborted || !isCurrent()) return { kind: "close" };
      throw error;
    }
    if (signal.aborted || !isCurrent()) return { kind: "close" };
    if (!confirmed) {
      selectedPath = selected.relativePath;
      continue;
    }

    try {
      await storage.deleteNote(snapshot.relativePath, snapshot.revision, signal);
    } catch (error) {
      if (signal.aborted || !isCurrent()) return { kind: "close" };
      safeNotify(ctx, `Pi Notes failed to delete the selected note: ${safeErrorMessage(error)}`, "error");
      selectedPath = selected.relativePath;
      continue;
    }
    if (signal.aborted || !isCurrent()) return { kind: "close" };
    safeNotify(ctx, `Deleted note: ${displayNotePath(selected)}`, "info");
  }

  return { kind: "close" };
}

function deleteConfirmationMessage(note: MarkdownEntry, size: number): string {
  return [
    `Note: ${displayNotePath(note)}`,
    `Size: ${size} bytes`,
    "",
    "Delete this Markdown note? This cannot be undone.",
    "Its saved child conversation will remain under pi-notes/sessions/.",
  ].join("\n");
}

function displayNotePath(note: MarkdownEntry): string {
  return sanitizeTerminalText(note.displayPath).trim() || "(unprintable note path)";
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
