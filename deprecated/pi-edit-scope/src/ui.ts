import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { HorizontalRule, hardWrapTerminalDocument, renderBoundedFrameLayout } from "@narumitw/pi-tui-kit";

export function scopeFrame(
  tui: TUI,
  theme: Theme,
  width: number,
  title: string,
  context: readonly string[],
  content: readonly string[],
  priorityRows: readonly number[],
  focusedRow?: number,
  hints: readonly string[] = [],
) {
  // The owned overlay uses terminal bounds; three spare rows are presentation
  // space, not a prediction of the native editor dock or another widget's height.
  const rows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
  const rule = new HorizontalRule({ ruleStyle: (line) => theme.fg("border", line) });
  return renderBoundedFrameLayout({
    width,
    maxRows: Math.max(1, rows - 3),
    rule: rule.render(width)[0] ?? "",
    title: [theme.fg("accent", theme.bold(title))],
    context: context.flatMap((line) => hardWrapTerminalDocument(line, width).map((part) => theme.fg("muted", part))),
    content,
    hints: hints.flatMap((line) => exactRows(line, width).map((part) => theme.fg("dim", part))),
    compactHint: hints[0] ? theme.fg("dim", hints[0]) : "",
    priorityRows,
    focusedRow,
  });
}

export function exactRows(value: string, width: number): string[] {
  return hardWrapTerminalDocument(value, width);
}

/**
 * Pi does not expose the editor dock's allocated height to custom components.
 * A full-width bottom overlay gives every Scope screen the real terminal bounds
 * without inspecting, hiding, or changing another component's widgets or footer.
 */
export function scopeOverlayContext(ctx: ExtensionCommandContext): ExtensionCommandContext {
  const ui = ctx.ui;
  const custom: ExtensionUIContext["custom"] = (factory, options) =>
    ui.custom(
      (tui, theme, keys, done) => {
        const created = factory(tui, theme, keys, done);
        return created instanceof Promise
          ? created.then((component) => boundedOverlay(component, tui, theme))
          : boundedOverlay(created, tui, theme);
      },
      {
        ...options,
        overlay: true,
        overlayOptions: {
          anchor: "bottom-left",
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
      },
    );
  const scopedUI = new Proxy(ui, {
    get(target, key) {
      if (key === "custom") return custom;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(ctx, {
    get(target, key) {
      if (key === "ui") return scopedUI;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function boundedOverlay<C extends Component>(component: C, tui: TUI, theme: Theme): C {
  const render = (width: number) => {
    width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (width === 0) return [];
    const lines = component.render(width);
    const height = Math.max(1, Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24);
    if (lines.length <= height) return lines;
    // Scope and Kit menu frames already fit. Kit's fixed-height task loader can
    // overflow tiny terminals: remove only its frame/spacing, then retain the
    // task label through the public bounded frame without changing cancellation.
    const rule = new HorizontalRule({ ruleStyle: (line) => theme.fg("border", line) }).render(width)[0] ?? "";
    const framed = lines[0] === rule && lines.at(-1) === rule;
    const content = (framed ? lines.slice(1, -1) : lines).filter((line) => stripVTControlCharacters(line).trim());
    return renderBoundedFrameLayout({ width, maxRows: height, rule, title: [], content, priorityRows: [0] }).lines;
  };
  return new Proxy(component, {
    get(target, key) {
      if (key === "render") return render;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target);
    },
  });
}
