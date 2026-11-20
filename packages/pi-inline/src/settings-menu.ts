import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionCommandContext,
  getSettingsListTheme,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  matchesKey,
  type SettingItem,
  SettingsList,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  HorizontalRule,
  renderBoundedFrameLayout,
  runCustomInteraction,
  sanitizeTerminalDocument,
} from "@narumitw/pi-tui-kit";
import type { PromptHintChange, PromptHintSettings } from "./settings.js";

interface InlineSettingsOptions {
  signal: AbortSignal;
  wikilinks: boolean;
  setWikilinks(enabled: boolean): void;
  saved: PromptHintSettings;
  active: PromptHintSettings;
  saveBlocked: boolean;
  save(change: PromptHintChange, signal: AbortSignal): Promise<boolean>;
}

const VALUES = ["On", "Off"];
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function onOff(enabled: boolean) {
  return enabled ? "On" : "Off";
}

export async function showInlineSettings(
  ctx: ExtensionCommandContext,
  options: InlineSettingsOptions,
): Promise<boolean> {
  const result = await runCustomInteraction<boolean>(ctx, {
    blocked: { kind: "question", message: "Edit Inline settings" },
    signal: options.signal,
    create({ tui, theme, keybindings, signal, complete }) {
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      const cursor = stripVTControlCharacters(getSettingsListTheme().cursor);
      const reloadPending =
        options.saved.enabled !== options.active.enabled || options.saved.text !== options.active.text;
      const promptValue = `${onOff(options.saved.enabled)}${reloadPending ? " (reload pending)" : ""}`;
      let pending: Promise<void> | undefined;
      let editor: ReturnType<typeof createPromptHintEditor> | undefined;
      let focused = false;
      let renderedWidth = 0;
      let contentHeight = 0;
      let mousePressed = false;
      const mouseRows = new Map<number, number>();

      function save(change: PromptHintChange, unchanged?: () => void) {
        if (signal.aborted || pending || options.saveBlocked) return;
        pending = Promise.resolve().then(async () => {
          try {
            if (signal.aborted) return;
            const changed = await options.save(change, signal);
            if (signal.aborted) return;
            if (changed) complete(true);
            else unchanged?.();
          } catch (error) {
            if (signal.aborted) return;
            const detail = error instanceof Error ? sanitizeTerminalDocument(error.message).replace(/\n/gu, " ") : "";
            ctx.ui.notify(detail || "Could not save the prompt hint.", "error");
          } finally {
            pending = undefined;
            if (!signal.aborted) tui.requestRender();
          }
        });
      }

      const items: SettingItem[] = [
        {
          id: "wikilinks",
          label: "Wikilinks",
          currentValue: onOff(options.wikilinks),
          values: VALUES,
          description: "Resolve Wikilinks in this session.",
        },
        {
          id: "promptHintEnabled",
          label: "Prompt Hint",
          currentValue: promptValue,
          values: options.saveBlocked ? undefined : [promptValue, onOff(!options.saved.enabled)],
          description: reloadPending
            ? `The active hint is ${onOff(options.active.enabled)}. Reload to apply saved settings.`
            : "Include the saved prompt hint in new sessions.",
        },
        {
          id: "promptHintText",
          label: "Edit Prompt Hint…",
          currentValue: "",
          description: "Edit the saved text, even when Prompt Hint is Off.",
          submenu: options.saveBlocked
            ? undefined
            : (_value, finish) => {
                const back = () => {
                  if (editor) editor.focused = false;
                  editor = undefined;
                  mousePressed = false;
                  mouseRows.clear();
                  finish();
                };
                editor = createPromptHintEditor(tui, theme, keybindings, options.saved.text, back, (value) => {
                  save({ key: "promptHintText", value }, back);
                });
                editor.focused = focused;
                mouseRows.clear();
                return editor;
              },
        },
      ];
      const list = new SettingsList(
        items,
        items.length,
        {
          label: (text, selected) => (selected ? theme.fg("accent", text) : text),
          value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
          description: (text) => theme.fg("muted", text),
          cursor: theme.fg("accent", cursor),
          hint: (text) => theme.fg("muted", text),
        },
        (id, value) => {
          if (signal.aborted) return;
          if (id === "wikilinks") options.setWikilinks(value === "On");
          if (id === "promptHintEnabled") {
            // Native SettingsList cycles first; keep the displayed value until a save succeeds.
            list.updateValue(id, promptValue);
            save({ key: id, value: value === "On" });
          }
        },
        () => complete(false),
      );

      return {
        capturesViewportInput: true,
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          if (editor) editor.focused = value;
        },
        render(width: number) {
          renderedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
          // The native list needs four cells for its row prefix and description layout.
          // Drop its fixed Enter/Space/Esc hint; it does not reflect remapped bindings.
          const content = editor ? editor.render(renderedWidth) : list.render(Math.max(4, renderedWidth)).slice(0, -2);
          contentHeight = content.length;
          const focusedRow = content.findIndex((line) =>
            editor ? line.includes(CURSOR_MARKER) : stripVTControlCharacters(line).startsWith(cursor),
          );
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const status = pending
            ? "Saving prompt hint…"
            : options.saveBlocked
              ? "Repair pi-inline.json before saving prompt settings."
              : undefined;
          const frame = renderBoundedFrameLayout({
            width: renderedWidth,
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(renderedWidth)[0] ?? "",
            title: [theme.fg("accent", theme.bold(editor ? "Edit Prompt Hint" : "Inline Settings"))],
            context: status ? [theme.fg("muted", status)] : [],
            content,
            priorityRows: focusedRow < 0 ? [] : [focusedRow],
            focusedRow,
          });
          mouseRows.clear();
          for (const { frameIndex, contentIndex } of frame.contentRows) mouseRows.set(frameIndex, contentIndex);
          return frame.lines;
        },
        invalidate() {
          list.invalidate();
          rule.invalidate();
          mouseRows.clear();
          mousePressed = false;
        },
        handleInput(data: string) {
          if (signal.aborted) return;
          mousePressed = false;
          mouseRows.clear();
          if (matchesKey(data, "ctrl+c") && !editor?.pasting) complete(false);
          else if (pending) {
            if (keybindings.matches(data, "tui.select.cancel")) complete(false);
          } else list.handleInput(data);
          if (!signal.aborted) tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent) {
          if (signal.aborted || pending) return;
          const nativeRow = mouseRows.get(event.y);
          if (nativeRow === undefined || event.x < 0 || event.x >= renderedWidth) {
            mousePressed = false;
            return;
          }
          const nativeEvent = { ...event, y: nativeRow, width: renderedWidth, height: contentHeight };
          if (!editor && event.type === "click" && event.button === "left" && !mousePressed) {
            // Clear a stale native press when a previous gesture ended outside the list.
            list.handleMouse({ ...nativeEvent, type: "press" });
          }
          const result = list.handleMouse(nativeEvent);
          if (event.type === "press" && event.button === "left") mousePressed = result?.handled === true;
          if (event.type === "click" || event.type === "wheel") mousePressed = false;
          if (result?.handled && result.render !== false && !signal.aborted) tui.requestRender();
          return result;
        },
        dispose() {
          if (editor) editor.focused = false;
          mouseRows.clear();
        },
        waitForPending: () => pending ?? Promise.resolve(),
      };
    },
  });
  return result.kind === "completed" && result.value;
}

function createPromptHintEditor(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  initialText: string,
  back: () => void,
  save: (text: string) => void,
) {
  const muted = (text: string) => theme.fg("muted", text);
  const editor = new Editor(tui, {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: muted,
      scrollInfo: muted,
      noMatch: muted,
    },
  });
  editor.setText(initialText);
  // Pi expands tabs to four spaces in the editor. Do not write that expansion on an untouched submit.
  const initialDraft = editor.getExpandedText();
  let pasteTail: string | undefined;
  const displaySafe = () => sanitizeTerminalDocument(editor.getText()) === editor.getText();

  function handleInput(data: string) {
    if (data.includes(PASTE_START)) pasteTail = "";
    if (pasteTail !== undefined) {
      const packet = pasteTail + data;
      const end = packet.indexOf(PASTE_END);
      if (end < 0) {
        pasteTail = packet.slice(1 - PASTE_END.length);
        editor.handleInput(data);
        return;
      }
      const boundary = end + PASTE_END.length - pasteTail.length;
      pasteTail = undefined;
      editor.handleInput(data.slice(0, boundary));
      if (boundary < data.length) handleInput(data.slice(boundary));
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      back();
      return;
    }
    if (!keybindings.matches(data, "tui.input.submit") && !matchesKey(data, "enter")) {
      editor.handleInput(data);
      return;
    }
    // Delegate key priority and newline fallbacks to Pi. Its submit clears and trims the draft.
    // Keep the exact state before that clear, including any Backspace Pi performed before submit.
    let draft = editor.getExpandedText();
    let previous = draft;
    editor.onChange = () => {
      previous = draft;
      draft = editor.getExpandedText();
    };
    editor.onSubmit = () => {
      editor.onChange = undefined;
      if (previous === initialDraft && initialDraft !== initialText) {
        back();
        return;
      }
      editor.setText(previous);
      save(previous);
    };
    try {
      editor.handleInput(data);
    } finally {
      editor.onChange = undefined;
      editor.onSubmit = undefined;
    }
  }

  return {
    get focused() {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
    get pasting() {
      return pasteTail !== undefined;
    },
    render: (width: number) =>
      displaySafe()
        ? editor.render(width)
        : [theme.fg("warning", "Draft contains unsafe terminal text. Undo or edit it.")],
    invalidate: () => editor.invalidate(),
    handleInput,
    handleMouse: (event: TuiMouseEvent) => (displaySafe() ? editor.handleMouse(event) : undefined),
  };
}
