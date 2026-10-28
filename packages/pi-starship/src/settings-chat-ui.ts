import type { Agent } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  isKeyRelease,
  Key,
  matchesKey,
  parseKey,
  type TUI,
  TUI_KEYBINDINGS,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { HorizontalRule, renderBoundedFrame } from "@narumitw/pi-tui-kit";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import type { WorkflowOwner } from "./command-configuration.js";
import { runSettingsChatFullscreen } from "./settings-chat-fullscreen.js";
import { SettingsChatScrollView } from "./settings-chat-scroll.js";
import { createSettingsChatTranscript } from "./settings-chat-transcript.js";
import type { SettingsDraft } from "./settings-draft.js";

export type SettingsChatAction = "save" | "discard";

const SAVE_SHORTCUTS = [
  { key: "ctrl+s", inputs: ["\x13", "\x1b[115;5u", "\x1b[27;5;115~"] },
  { key: "f2", inputs: ["\x1bOQ", "\x1b[12~", "\x1b[[B"] },
] as const;

/** Never replace native editing, cancellation, or registered message actions. */
function saveKeyReserved(data: string, keybindings: Pick<KeybindingsManager, "matches">): boolean {
  const editorKeys = getKeybindings();
  return (
    (Object.keys(TUI_KEYBINDINGS) as Array<keyof typeof TUI_KEYBINDINGS>).some(
      (action) => editorKeys.matches(data, action) || keybindings.matches(data, action),
    ) ||
    (
      [
        "app.clipboard.pasteImage",
        "app.interrupt",
        "app.exit",
        "app.message.followUp",
        "app.message.dequeue",
        "app.tools.expand",
      ] as const
    ).some((action) => keybindings.matches(data, action))
  );
}

/** Check supported input encodings through Pi's matcher before displaying a save hint. */
export function settingsChatSaveShortcut(
  keybindings: Pick<KeybindingsManager, "matches">,
): "ctrl+s" | "f2" | undefined {
  return SAVE_SHORTCUTS.find(({ key, inputs }) => {
    const matching = inputs.filter((data) => matchesKey(data, key));
    return matching.length > 0 && matching.every((data) => !saveKeyReserved(data, keybindings));
  })?.key;
}

export interface ChatViewState {
  input: string;
  error: string;
  toolsExpanded?: boolean;
}

/** Add labels only to the public Editor border hooks; native scroll indicators keep priority. */
export class SettingsChatEditor extends CustomEditor {
  constructor(
    tui: TUI,
    private readonly chromeTheme: Theme,
    private readonly labels: () => { top: string; bottom: string },
    chatKeys: KeybindingsManager,
  ) {
    super(
      tui,
      {
        borderColor: (text) => chromeTheme.fg("borderMuted", text),
        selectList: {
          selectedPrefix: (text) => chromeTheme.fg("accent", text),
          selectedText: (text) => chromeTheme.fg("accent", text),
          description: (text) => chromeTheme.fg("muted", text),
          scrollInfo: (text) => chromeTheme.fg("dim", text),
          noMatch: (text) => chromeTheme.fg("warning", text),
        },
      },
      chatKeys,
    );
  }
  /** Bypass app shortcuts while the native Editor owns a bracketed paste. */
  handlePasteInput(data: string): void {
    Editor.prototype.handleInput.call(this, data);
  }
  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount > 0
      ? super.renderTopBorder(width, hiddenLineCount)
      : this.labeledBorder(width, this.labels().top);
  }
  protected renderBottomBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount > 0
      ? super.renderBottomBorder(width, hiddenLineCount)
      : this.labeledBorder(width, this.labels().bottom);
  }
  private labeledBorder(width: number, label: string): string {
    return (
      new HorizontalRule({
        label,
        labelAlignment: "left",
        ruleStyle: this.borderColor,
        labelStyle: (text) => this.chromeTheme.fg("dim", text),
      }).render(width)[0] ?? ""
    );
  }
}

// Native fullscreen actions evaluated before the focused root component. Search
// navigation/close are conditional on a focused search overlay, not this editor.
const ROOT_VIEWPORT_ACTIONS = [
  "tui.altScreen.search",
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.lineUp",
  "tui.altScreen.lineDown",
  "tui.altScreen.previousPrompt",
  "tui.altScreen.nextPrompt",
  "tui.altScreen.top",
  "tui.altScreen.bottom",
] as const;

/** Native viewport/editor actions win collisions; Escape is an executable stop fallback. */
export function settingsChatStopInput(data: string, keybindings: Pick<KeybindingsManager, "matches">): boolean {
  const editorKeys = getKeybindings();
  const parsed = parseKey(data);
  const textKey = parsed?.startsWith("shift+") ? parsed.slice(6) : parsed;
  const printable =
    data.charCodeAt(0) >= 32 || (textKey !== undefined && (Array.from(textKey).length === 1 || textKey === "space"));
  // These native Editor branches remain active even when their configurable actions are remapped.
  const nativeEditing =
    printable ||
    matchesKey(data, "shift+backspace") ||
    matchesKey(data, "shift+delete") ||
    data.charCodeAt(0) === 10 ||
    data === "\x1b\r" ||
    data === "\x1b[13;2~" ||
    (data.includes("\x1b") && data.includes("\r"));
  const editing =
    nativeEditing ||
    (Object.keys(TUI_KEYBINDINGS) as Array<keyof typeof TUI_KEYBINDINGS>)
      .filter((key) => key.startsWith("tui.editor.") || key.startsWith("tui.input."))
      .some((key) => editorKeys.matches(data, key));
  const viewport = ROOT_VIEWPORT_ACTIONS.some((action) => editorKeys.matches(data, action));
  return !viewport && !editing && (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape));
}

export function createSettingsChatComponent(options: {
  agent: Agent;
  draft: SettingsDraft;
  state: ChatViewState;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  signal: AbortSignal;
  preview(width: number): string[];
  complete(value: SettingsChatAction): void;
}) {
  const { agent, draft, state, tui, theme, keybindings, signal } = options;
  let disposed = false;
  let inPaste = false;
  let pending: Promise<void> | undefined;
  let stopping = false;
  const queued: Array<{ kind: "steer" | "followUp"; message: UserMessage; text: string }> = [];
  const editor = new SettingsChatEditor(
    tui,
    theme,
    () => {
      const status =
        state.error || agent.state.errorMessage
          ? "Agent error"
          : !draft.candidate
            ? "Invalid"
            : draft.diagnostics
              ? "Warnings"
              : "Valid";
      const saveKey = !pending && !inPaste && draft.candidate ? settingsChatSaveShortcut(keybindings) : undefined;
      // Match Pi core: sentence-case states and lowercase key + "to" action hints.
      const working = !inPaste && settingsChatStopInput("\x1b", keybindings) ? "Working · esc to interrupt" : "Working";
      return {
        top: queued.length > 0 ? `pi-starship · ${queued.length} queued` : "pi-starship",
        bottom: `${status} · unsaved · ${pending ? working : saveKey ? `${saveKey} to save profile` : "Idle"} · ctrl+c to discard`,
      };
    },
    keybindings,
  );
  editor.setText(state.input);
  const render = () => {
    if (!disposed && !signal.aborted) tui.requestRender();
  };
  // Update transcript identities before this listener requests the next frame.
  const transcript = createSettingsChatTranscript(
    agent,
    tui,
    draft.directory,
    state.toolsExpanded ?? false,
    draft.path,
  );
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_start") {
      const index = queued.findIndex((item) => item.message === event.message);
      if (index >= 0) queued.splice(index, 1);
    }
    render();
  });
  const clearQueue = () => {
    queued.length = 0;
    agent.clearAllQueues();
  };
  const restoreQueue = () => {
    const messages = [
      ...queued.filter((item) => item.kind === "steer"),
      ...queued.filter((item) => item.kind === "followUp"),
    ].map((item) => item.text);
    clearQueue();
    if (messages.length > 0) editor.setText([...messages, editor.getExpandedText()].filter(Boolean).join("\n\n"));
  };
  const abort = () => {
    stopping = true;
    clearQueue();
    agent.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
  const failed = () => {
    const last = agent.state.messages.at(-1);
    return last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
  };
  const submit = (input: string, kind: "steer" | "followUp") => {
    if (signal.aborted || disposed) return;
    if (!input.trim()) return;
    // Native submission clears the editor first. Retain input typed while an abort settles.
    if (pending && stopping) {
      editor.setText(input);
      return;
    }
    editor.addToHistory(input);
    editor.setText("");
    state.error = "";
    if (pending) {
      const message: UserMessage = { role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() };
      queued.push({ kind, message, text: input });
      if (kind === "steer") agent.steer(message);
      else agent.followUp(message);
    } else {
      stopping = false;
      pending = (async () => {
        try {
          await agent.prompt(input);
          // agent_end listeners can enqueue after the loop's final poll. Wait for actual
          // idle settlement before continuing; never resume cancelled or failed runs.
          while (!disposed && !signal.aborted && !stopping && !failed() && agent.hasQueuedMessages()) {
            await agent.continue();
          }
        } catch (error) {
          if (!disposed && !signal.aborted) state.error = error instanceof Error ? error.message : String(error);
        } finally {
          pending = undefined;
          if (!disposed && !signal.aborted) restoreQueue();
          else clearQueue();
          render();
        }
      })();
    }
    render();
  };
  // Native Editor expands paste markers and clears itself before calling onSubmit.
  editor.onSubmit = (input) => submit(input, "steer");
  editor.onAction("app.message.followUp", () => submit(editor.getExpandedText().trim(), "followUp"));
  editor.onAction("app.message.dequeue", restoreQueue);
  editor.onAction("app.tools.expand", () => {
    state.toolsExpanded = transcript.toggleTools();
  });
  const dock: Component = {
    render(width: number): string[] {
      if (disposed || signal.aborted || width <= 0) return [];
      const rows = Math.max(0, Math.floor(Number.isFinite(tui.terminal.rows) ? tui.terminal.rows : 24));
      if (rows === 0) return [];
      const input = editor.render(Math.max(3, width)).map((line) => truncateToWidth(line, width, ""));
      const cursor = Math.max(
        0,
        input.findIndex((line) => line.includes(CURSOR_MARKER)),
      );
      const preview = options.preview(width);
      const diagnostics = sanitizeTerminalDocument(state.error || agent.state.errorMessage || draft.diagnostics)
        .split("\n")
        .filter(Boolean)
        .slice(0, 3);
      // Keep the draft preview outside the scrollable history.
      const details = diagnostics.map((line) => theme.fg("muted", line));
      // Render the footer without extra rules, matching its saved position at the terminal bottom.
      if (input.length + preview.length > rows) {
        return renderBoundedFrame({
          width,
          maxRows: rows,
          rule: rule.render(width)[0] ?? "",
          title: [],
          content: [...input, theme.fg("muted", "Footer preview hidden — enlarge the terminal"), ...details],
          focusedRow: cursor,
          priorityRows: [cursor, input.length],
        });
      }
      const detailLines = details.slice(0, rows - input.length - preview.length);
      const queueLines = [
        ...queued.filter((item) => item.kind === "steer"),
        ...queued.filter((item) => item.kind === "followUp"),
      ]
        .slice(0, Math.min(3, rows - input.length - preview.length - detailLines.length))
        .map((item) =>
          theme.fg(
            "dim",
            `${item.kind === "steer" ? "Steering" : "Follow-up"}: ${sanitizeTerminalDocument(item.text).replace(/\n/gu, " ")}`,
          ),
        );
      const content = [...queueLines, ...input, ...detailLines, ...preview];
      return content.map((line) => truncateToWidth(line, width, ""));
    },
    invalidate() {
      editor.invalidate();
    },
  };
  const history: Component = {
    render(width) {
      // Capture against the previous frame's spans before rebuilding identities.
      scroll.anchor = scroll.isFollowingEnd ? undefined : transcript.anchorAt(scroll.scrollTop);
      return transcript.render(width);
    },
    invalidate() {
      transcript.invalidate();
    },
    handleMouse: (event) => transcript.handleMouse(event),
  };
  const scroll = new SettingsChatScrollView(history, {
    primary: true,
    follow: "end",
    scrollbar: "auto",
    scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
    scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
  });
  scroll.restoreAnchor = (anchor) => transcript.rowAt(anchor);
  const layout = new VStack([
    { component: scroll, basis: 0, grow: 1, minSize: 0 },
    { component: dock, basis: "auto", shrink: 1, minSize: 1 },
  ]);
  return {
    getFullscreenLayout() {
      return layout;
    },
    get focused() {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
    render(width: number): string[] {
      if (disposed || signal.aborted || width <= 0 || tui.terminal.rows <= 0) return [];
      return layout.render(width);
    },
    invalidate() {
      editor.invalidate();
      transcript.invalidate();
    },
    handleInput(data: string) {
      if (disposed || signal.aborted || isKeyRelease(data)) return;
      const saveKey = !pending && draft.candidate ? settingsChatSaveShortcut(keybindings) : undefined;
      // Forward entire paste packets and fragments without interpreting embedded shortcuts.
      if (inPaste || data.includes("\x1b[200~")) {
        inPaste = !data.includes("\x1b[201~");
        editor.handlePasteInput(data);
      } else if (matchesKey(data, Key.ctrl("c"))) {
        abort();
        options.complete("discard");
      } else if (saveKey && matchesKey(data, saveKey) && !saveKeyReserved(data, keybindings)) {
        state.input = editor.getExpandedText();
        options.complete("save");
      } else if (settingsChatStopInput(data, keybindings)) {
        if (pending) {
          stopping = true;
          restoreQueue();
          agent.abort();
        }
      } else editor.handleInput(data);
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state.input = editor.getExpandedText();
      signal.removeEventListener("abort", abort);
      unsubscribe();
      transcript.dispose();
      scroll.setScrollbarActive(false);
      scroll.setScrollbar("hidden");
      abort();
    },
    async waitForPending() {
      await pending;
      await agent.waitForIdle();
    },
  };
}

export async function showSettingsChat(
  ctx: ExtensionCommandContext,
  agent: Agent,
  draft: SettingsDraft,
  state: ChatViewState,
  owner: WorkflowOwner,
  preview: (width: number) => string[],
): Promise<SettingsChatAction> {
  // Seed this side thread once from the public parent display preference. Its
  // later Ctrl+O changes remain local, including across review/name cancellation.
  state.toolsExpanded ??= ctx.ui.getToolsExpanded?.() ?? false;
  return runSettingsChatFullscreen(
    ctx,
    owner,
    ({ tui, theme, keybindings, signal, complete }) =>
      createSettingsChatComponent({ agent, draft, state, tui, theme, keybindings, signal, preview, complete }),
    "discard" as SettingsChatAction,
  );
}
