import { type ExtensionCommandContext, ExtensionEditorComponent } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { HorizontalRule, renderBoundedFrameLayout, runCustomInteraction } from "@narumitw/pi-tui-kit";
import type { ImagegenMenuOwner } from "./menu.js";
import { renderSafeInput } from "./safe-input-render.js";

export type ImagegenPromptResult = { kind: "submitted"; prompt: string } | { kind: "back" | "close" | "stale" };

export async function showImagegenPrompt(
  ctx: ExtensionCommandContext,
  owner: Pick<ImagegenMenuOwner, "signal" | "isCurrent">,
): Promise<ImagegenPromptResult> {
  const result = await runCustomInteraction<ImagegenPromptResult>(ctx, {
    signal: owner.signal,
    isCurrent: owner.isCurrent.bind(owner),
    onError: () => {
      if (!owner.signal.aborted && owner.isCurrent()) ctx.ui.notify("Image prompt editor failed.", "error");
    },
    create: ({ tui, theme, keybindings, signal, complete }) => {
      const native = new ExtensionEditorComponent(
        tui,
        keybindings,
        "Image prompt",
        undefined,
        // Native submission expands large-paste markers before clearing the draft.
        (prompt) => {
          if (prompt.trim()) complete({ kind: "submitted", prompt });
        },
        () => complete({ kind: "back" }),
      );
      // Inspect the public Container children, not the native editor's private state.
      // Keep native editing, paste expansion, focus, and mouse handling. The owned frame
      // replaces native hints because external-editor launch is deliberately unavailable:
      // Pi's external-editor handoff cannot honor dialog disposal or abort.
      const editor = native.children.find((child): child is Editor => child instanceof Editor);
      if (!editor) throw new Error("Pi multiline editor is unavailable");
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      let rows = new Map<number, number>();
      let width = 0;
      let height = 0;
      const clearGeometry = () => {
        rows.clear();
        width = 0;
        height = 0;
      };
      return {
        get focused() {
          return native.focused;
        },
        set focused(value: boolean) {
          native.focused = value;
        },
        render(availableWidth) {
          // Editing and wrapping remain Pi-owned; sanitize its display, not its draft.
          // Pi Editor recurses when a wide grapheme cannot fit its layout.
          // Reserve two native content cells plus its cursor cell, then let Kit
          // clip the safe result to the actual (including zero) screen width.
          const content = renderSafeInput(editor, Math.max(3, availableWidth));
          const cursorRow = content.findIndex((line) => line.includes(CURSOR_MARKER));
          const focusedRow = cursorRow < 0 ? Math.min(1, content.length - 1) : cursorRow;
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const layout = renderBoundedFrameLayout({
            width: availableWidth,
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(availableWidth)[0] ?? "",
            title: [theme.fg("accent", "Generate Image")],
            context: [theme.fg("muted", "Your prompt is sent to ChatGPT. Provider quota applies.")],
            content,
            focusedRow,
            priorityRows: [focusedRow],
          });
          width = Math.max(0, Math.floor(availableWidth));
          height = layout.lines.length;
          rows = new Map(layout.contentRows.map(({ frameIndex, contentIndex }) => [frameIndex, contentIndex]));
          return layout.lines;
        },
        handleInput(data) {
          if (signal.aborted || isKeyRelease(data)) return;
          clearGeometry();
          if (matchesKey(data, "ctrl+c")) complete({ kind: "close" });
          else if (keybindings.matches(data, "tui.select.cancel")) complete({ kind: "back" });
          else if (!keybindings.matches(data, "app.editor.external")) native.handleInput(data);
          tui.requestRender();
        },
        handleMouse(event) {
          if (signal.aborted || event.x < 0 || event.x >= width || event.y < 0 || event.y >= height) return undefined;
          const y = rows.get(event.y);
          if (y === undefined) return undefined;
          const handled = editor.handleMouse?.({ ...event, y, height: editor.render(Math.max(3, width)).length });
          // Release and synthesized click share the last published frame in Pi.
          if (handled) tui.requestRender();
          return handled;
        },
        invalidate() {
          native.invalidate();
          rule.invalidate();
          clearGeometry();
        },
        dispose() {
          clearGeometry();
          native.focused = false;
        },
      };
    },
  });
  return result.kind === "completed" ? result.value : { kind: "stale" };
}
