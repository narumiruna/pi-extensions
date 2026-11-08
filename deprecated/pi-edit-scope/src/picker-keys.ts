import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { formatInteractionHints } from "@narumitw/pi-tui-kit";

export type PickerPanel = "files" | "path";
export type PickerAction =
  | "close"
  | "cancel"
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "apply"
  | "mark"
  | "markUp"
  | "paths"
  | "add"
  | "submit"
  | "input";
const selection = [
  ["cancel", "tui.select.cancel"],
  ["up", "tui.select.up"],
  ["down", "tui.select.down"],
  ["pageUp", "tui.select.pageUp"],
  ["pageDown", "tui.select.pageDown"],
  ["apply", "tui.select.confirm"],
] as const;
const editing = [
  "tui.editor.undo",
  "tui.input.submit",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.cursorLeft",
  "tui.editor.cursorRight",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
] as const;
const viewportBindings = Object.keys(TUI_KEYBINDINGS).filter(
  (binding) => binding.startsWith("tui.altScreen.") && !binding.startsWith("tui.altScreen.search"),
) as (keyof typeof TUI_KEYBINDINGS)[];
// Prove familiar input families with Pi's matcher, without guessing arbitrary remaps.
// Unproven keys still dispatch natively, but do not receive a literal key hint.
const hintInputs = [
  "\r",
  "\n",
  "\x1bOM",
  "\x1b",
  "\t",
  "\x1b[Z",
  "\x10",
  "\x0f",
  "\x1bo",
  "\x1b[111;3u",
  "\x1b[A",
  "\x1b[B",
  "\x1b[5~",
  "\x1b[6~",
  ...["OP", "OQ", "OR", "OS", "[15~", "[17~", "[18~", "[19~", "[20~", "[21~", "[23~", "[24~"].map(
    (suffix) => `\x1b${suffix}`,
  ),
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ",
];

export function pickerKeys(tui: TUI, keybindings: KeybindingsManager) {
  const hostAllows = (data: string) => {
    if (tui.onDebug && matchesKey(data, "shift+ctrl+d")) return false;
    if (tui.mode !== "fullscreen") return true;
    const host = getKeybindings();
    if (host.matches(data, "tui.altScreen.search")) return false;
    return tui.hasOverlay() || !viewportBindings.some((binding) => host.matches(data, binding));
  };
  const filesAction = (data: string): PickerAction | undefined => {
    if (matchesKey(data, "ctrl+c")) return "close";
    for (const [name, binding] of selection) if (keybindings.matches(data, binding)) return name;
    // Native editing/submission wins over additional marking and view shortcuts.
    if (data === "\n" || editing.some((binding) => keybindings.matches(data, binding))) return "input";
    if (keybindings.matches(data, "tui.input.tab")) return "mark";
    if (matchesKey(data, "shift+tab")) return "markUp";
    if (keybindings.matches(data, "app.session.togglePath")) return "paths";
  };
  const addKey = () =>
    (["ctrl+o", "alt+o"] as const).find((key) => {
      const inputs = hintInputs.filter((input) => matchesKey(input, key));
      return inputs.length > 0 && inputs.every((input) => hostAllows(input) && filesAction(input) === undefined);
    });
  const action = (data: string, panel: PickerPanel): PickerAction | undefined => {
    if (panel === "files") {
      const native = filesAction(data);
      if (native) return native;
      const add = addKey();
      if (add && matchesKey(data, add)) return "add";
      return;
    }
    if (matchesKey(data, "ctrl+c")) return "close";
    if (keybindings.matches(data, "tui.select.cancel")) return "cancel";
    // Match Input's ordering: cancellation, undo, then submission (including LF).
    if (keybindings.matches(data, "tui.editor.undo")) return "input";
    if (keybindings.matches(data, "tui.input.submit") || data === "\n") return "submit";
    return "input";
  };
  const bindings = (panel: PickerPanel) => ({
    getKeys(name: PickerAction): string[] {
      const binding =
        name === "mark"
          ? "tui.input.tab"
          : name === "paths"
            ? "app.session.togglePath"
            : name === "submit"
              ? "tui.input.submit"
              : selection.find(([action]) => action === name)?.[1];
      const candidates =
        name === "markUp"
          ? (["shift+tab"] as const)
          : name === "add"
            ? [addKey()].filter((key) => key !== undefined)
            : binding
              ? keybindings.getKeys(binding)
              : [];
      const key = candidates.find((key) => {
        const inputs = hintInputs.filter((input) => matchesKey(input, key));
        return inputs.length > 0 && inputs.every((input) => hostAllows(input) && action(input, panel) === name);
      });
      return key ? [key] : [];
    },
  });
  const label = (name: PickerAction, text: string, panel: PickerPanel = "files") =>
    formatInteractionHints(bindings(panel), [{ bindings: [name], label: text }]) || text;
  const hints = (panel: PickerPanel, count: number, busy: boolean) => {
    const keys = bindings(panel);
    const controls = formatInteractionHints(keys, [
      ...(!busy
        ? panel === "files"
          ? [
              { bindings: ["mark"] as const, label: "select" },
              { bindings: ["apply"] as const, label: count ? "apply" : "apply (select files)" },
              { bindings: ["markUp"] as const, label: "select ↑" },
            ]
          : [{ bindings: ["submit"] as const, label: "add file" }]
        : []),
      { bindings: ["cancel"], excludeKeys: ["ctrl+c"], label: panel === "files" ? "cancel" : "back" },
      ...(!keys.getKeys("cancel").length && hostAllows("\x03") ? [{ keys: ["ctrl+c"], label: "close" }] : []),
    ]);
    return panel === "files" ? `${count} selected • ${controls}` : controls;
  };
  return { action, hints, label };
}
