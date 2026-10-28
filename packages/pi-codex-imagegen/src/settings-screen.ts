import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
  HorizontalRule,
  renderBoundedFrameLayout,
  runCustomInteraction,
  sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";
import type { ImagegenMenuOwner } from "./menu.js";
import type { ImagegenSettings } from "./settings.js";

export async function showImagegenSettings(
  ctx: ExtensionCommandContext,
  owner: ImagegenMenuOwner,
): Promise<"back" | "close" | "stale"> {
  const result = await runCustomInteraction<"back" | "close">(ctx, {
    signal: owner.signal,
    isCurrent: owner.isCurrent.bind(owner),
    onError: () => {
      if (!owner.signal.aborted && owner.isCurrent()) ctx.ui.notify("Image generation settings failed.", "error");
    },
    create: ({ tui, theme, signal, complete }) => {
      let disposed = false;
      let closing = false;
      const finish = (reason: "back" | "close") => {
        closing = true;
        complete(reason);
      };
      let pending = Promise.resolve();
      const counts = new Map<string, number>();
      let rows = new Map<number, number>();
      let width = 0;
      let height = 0;
      const current = () => !owner.signal.aborted && owner.isCurrent();
      const clearGeometry = () => {
        rows.clear();
        width = 0;
        height = 0;
      };
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      const settings = owner.getSettings();
      const items: SettingItem[] = [
        {
          id: "toolEnabled",
          label: "Tool access",
          currentValue: String(settings.toolEnabled),
          values: ["false", "true"],
          description:
            "Allow model access at an idle boundary. Manual generation stays available. This changes model-visible tool definitions.",
        },
        {
          id: "transparentBackground",
          label: "Transparent background",
          currentValue: String(settings.transparentBackground),
          values: ["false", "true"],
          description: "Request a transparent background by default. The provider determines actual output support.",
        },
      ];
      // Retain the native control and theme contract, but use the callback theme.
      // Hide native hard-coded key hints: they are not valid for remapped bindings.
      const list = new SettingsList(
        items,
        items.length,
        {
          ...getSettingsListTheme(),
          label: (text, selected) => (selected ? theme.fg("accent", text) : text),
          value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
          description: (text) => theme.fg("muted", text),
          get cursor() {
            return theme.fg("accent", "→ ");
          },
          hint: () => "",
        },
        (id, value) => queue(id as keyof ImagegenSettings, value),
        () => finish("back"),
      );

      function queue(id: keyof ImagegenSettings, value: string): void {
        const patch: Partial<ImagegenSettings> = { [id]: value === "true" };
        list.updateValue(id, sanitizeTerminalText(value));
        counts.set(id, (counts.get(id) ?? 0) + 1);
        // Register in action order, and recover the queue after each rejected save.
        pending = pending
          .then(async () => {
            if (!current() || (disposed && !closing)) return;
            try {
              await owner.saveSettings(patch);
            } catch {
              if (current() && (!disposed || closing))
                ctx.ui.notify("Settings were not saved. The previous value was restored.", "error");
            }
          })
          .finally(() => {
            const remaining = (counts.get(id) ?? 1) - 1;
            counts.set(id, remaining);
            if (current() && !disposed && remaining === 0) {
              list.updateValue(id, sanitizeTerminalText(String(owner.getSettings()[id])));
              list.invalidate();
              clearGeometry();
              tui.requestRender();
            }
          });
      }

      return {
        render(availableWidth) {
          const content = list.render(Math.max(1, availableWidth));
          const focusedRow = Math.max(
            0,
            content.findIndex((line) => stripVTControlCharacters(line).startsWith("→")),
          );
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const layout = renderBoundedFrameLayout({
            width: availableWidth,
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(availableWidth)[0] ?? "",
            title: [theme.fg("accent", "Image Generation Settings")],
            context: [
              theme.fg("muted", `User scope: ${sanitizeTerminalText(owner.settingsPath)}`),
              theme.fg("muted", "Changes save immediately. Closing does not undo saved changes."),
            ],
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
          if (matchesKey(data, "ctrl+c")) finish("close");
          else list.handleInput(data);
          tui.requestRender();
        },
        handleMouse(event) {
          if (signal.aborted || event.x < 0 || event.x >= width || event.y < 0 || event.y >= height) return undefined;
          const y = rows.get(event.y);
          if (y === undefined) return undefined;
          const handled = list.handleMouse({ ...event, y, height: list.render(width).length });
          // Pi dispatches release and its synthesized click before the next render.
          // Retain the last published geometry until a real layout change.
          if (handled) tui.requestRender();
          return handled;
        },
        invalidate() {
          list.invalidate();
          rule.invalidate();
          clearGeometry();
        },
        waitForPending: () => pending,
        dispose() {
          disposed = true;
          clearGeometry();
        },
      };
    },
  });
  return result.kind === "completed" ? result.value : "stale";
}
