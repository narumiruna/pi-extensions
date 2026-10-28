import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseColor, Text } from "@earendil-works/pi-tui";
import {
  formatInteractionHints,
  HorizontalRule,
  renderBoundedFrame,
  runCustomInteraction,
  sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";
import { demoHasHardCancel, HARD_CANCEL_WARNING } from "./hard-cancel.js";
import type { ShowTuiKitShowcaseOptions } from "./runtime.js";

/** Stateless samples are rebuilt from the callback theme on every render. */
export function themeSampleLines(theme: Theme): string[] {
  return [
    `Active host theme: ${sanitizeTerminalText(theme.name ?? "unnamed")} · appearance: ${theme.appearance}`,
    theme.fg("accent", "Active role: accent"),
    theme.fg("success", "Active role: success"),
    theme.fg("warning", "Active role: warning"),
    theme.fg("error", "Active role: error"),
    theme.fg("muted", "Active role: muted description"),
    theme.style("Active theme.style(): bold success on toolSuccessBg", {
      fg: "success",
      bg: "toolSuccessBg",
      bold: true,
    }),
    theme.style("Concrete active color: colors.accent as background", {
      fg: theme.colors.text,
      bg: theme.colors.accent,
    }),
    theme.style("Sample DARK palette — not the host theme", {
      fg: parseColor("#e2e8f0"),
      bg: parseColor("#172033"),
      bold: true,
    }),
    theme.style("Sample LIGHT palette — not the host theme", {
      fg: parseColor("#172033"),
      bg: parseColor("#e2e8f0"),
      italic: true,
    }),
    "These samples do not change the active theme or hardware cursor.",
    "Physical test: close this view, use Pi /settings to change Theme and Show hardware cursor, then reopen an input demo.",
    "Check light/dark appearance, resize, and IME placement in the target terminal. Restore host settings yourself.",
  ];
}

export async function runThemeDemo(ctx: ExtensionCommandContext, options: ShowTuiKitShowcaseOptions): Promise<void> {
  await runCustomInteraction(ctx, {
    ...options,
    onError: () => {
      if (!options.signal.aborted && options.isCurrent() && ctx.hasUI) ctx.ui.notify("Theme sample failed.", "error");
    },
    create: ({ tui, theme, keybindings, signal, complete }) => {
      if (!demoHasHardCancel(tui, false)) {
        if (!signal.aborted && options.isCurrent() && ctx.hasUI) ctx.ui.notify(HARD_CANCEL_WARNING, "warning");
        complete(undefined);
        return { render: () => [], invalidate() {} };
      }
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      return {
        render(width: number) {
          if (signal.aborted || !options.isCurrent()) return [];
          const hint = formatInteractionHints(keybindings, [{ keys: ["ctrl+c"], label: "back" }]);
          return renderBoundedFrame({
            width,
            maxRows: Math.max(1, Math.floor(tui.terminal.rows) - 3),
            rule: rule.render(width)[0] ?? "",
            title: new Text(theme.fg("accent", theme.bold("Theme and style samples")), 0, 0).render(width),
            content: themeSampleLines(theme).flatMap((line) => new Text(line, 0, 0).render(width)),
            hints: new Text(theme.fg("dim", hint), 0, 0).render(width),
          });
        },
        invalidate() {
          rule.invalidate();
        },
        handleInput(data: string) {
          if (signal.aborted || !options.isCurrent()) return;
          if (matchesKey(data, "ctrl+c") || keybindings.matches(data, "tui.select.cancel")) complete(undefined);
        },
      };
    },
  });
}
