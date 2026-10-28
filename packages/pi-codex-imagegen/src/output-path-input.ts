import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { HorizontalRule, renderBoundedFrameLayout, runCustomInteraction } from "@narumitw/pi-tui-kit";
import type { ImagegenMenuOwner } from "./menu.js";
import { renderSafeInput } from "./safe-input-render.js";

export type ImagegenOutputPathResult = { kind: "submitted"; path: string } | { kind: "back" | "close" | "stale" };

export async function showImagegenOutputPath(
  ctx: ExtensionCommandContext,
  owner: Pick<ImagegenMenuOwner, "signal" | "isCurrent">,
): Promise<ImagegenOutputPathResult> {
  const result = await runCustomInteraction<ImagegenOutputPathResult>(ctx, {
    signal: owner.signal,
    isCurrent: owner.isCurrent.bind(owner),
    onError: () => {
      if (!owner.signal.aborted && owner.isCurrent()) ctx.ui.notify("Image output path input failed.", "error");
    },
    create: ({ tui, theme, keybindings, signal, complete }) => {
      const input = new Input();
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      let error = "";
      let inPaste = false;
      let rows = new Map<number, number>();
      let width = 0;
      let height = 0;
      const current = () => !signal.aborted && owner.isCurrent();
      const stale = () => {
        if (current()) return false;
        complete({ kind: "stale" });
        return true;
      };
      const clearGeometry = () => {
        rows.clear();
        width = 0;
        height = 0;
      };
      input.onSubmit = (path) => {
        if (stale()) return;
        if (path === "") error = "An output path is required.";
        else complete({ kind: "submitted", path });
      };
      input.onEscape = () => complete({ kind: "back" });
      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render(availableWidth) {
          const content = renderSafeInput(input, Math.max(1, availableWidth));
          if (error) content.push(theme.fg("error", error));
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const layout = renderBoundedFrameLayout({
            width: availableWidth,
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(availableWidth)[0] ?? "",
            title: [theme.fg("accent", "Image Output Path")],
            context: [
              theme.fg("muted", "Enter the exact output path. No filename or extension is added."),
              theme.fg("muted", "Relative paths use the generation request's working directory."),
              theme.fg("warning", "Existing files are overwritten. Symlinks are followed."),
            ],
            content,
            focusedRow: 0,
            priorityRows: error ? [0, 1] : [0],
          });
          width = Math.max(0, Math.floor(availableWidth));
          height = layout.lines.length;
          rows = new Map(layout.contentRows.map(({ frameIndex, contentIndex }) => [frameIndex, contentIndex]));
          return layout.lines;
        },
        handleInput(data) {
          if (stale()) return;
          // Let Input own bracketed paste, including split chunks that match shortcuts.
          const pasted = inPaste || data.includes("\x1b[200~");
          if (!pasted && isKeyRelease(data)) return;
          if (data.includes("\x1b[200~")) inPaste = true;
          if (data.includes("\x1b[201~")) inPaste = false;
          clearGeometry();
          if (!pasted && matchesKey(data, "ctrl+c")) complete({ kind: "close" });
          else if (!pasted && keybindings.matches(data, "tui.select.cancel")) complete({ kind: "back" });
          // Native Input uses tui.input.submit (not tui.select.confirm), editing and paste semantics.
          else input.handleInput(data);
          if (current()) tui.requestRender();
        },
        handleMouse(event) {
          if (stale() || event.x < 0 || event.x >= width || event.y < 0 || event.y >= height) return undefined;
          const y = rows.get(event.y);
          if (y !== 0) return undefined;
          const handled = input.handleMouse({ ...event, y, height: 1 });
          // Release and synthesized click share Pi's last published geometry.
          if (handled) tui.requestRender();
          return handled;
        },
        invalidate() {
          input.invalidate();
          rule.invalidate();
          clearGeometry();
        },
        dispose() {
          clearGeometry();
          input.focused = false;
        },
      };
    },
  });
  return result.kind === "completed" ? result.value : { kind: "stale" };
}
