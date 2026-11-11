import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";

type WidgetFactory = (_tui: never, theme: Theme) => Component & { dispose?(): void };

const IDENTITY_THEME = {
  fg: (_role: string, text: string) => text,
} as unknown as Theme;

export function renderMockWidget(value: unknown, width = 80): string[] {
  if (Array.isArray(value)) return value.map(String);
  return createMockWidget(value).render(width);
}

export function createMockWidget(value: unknown): Component & { dispose?(): void } {
  if (typeof value !== "function") throw new Error("Expected a widget factory");
  return (value as WidgetFactory)(undefined as never, IDENTITY_THEME);
}

export function widgetClick(x: number, y: number, height: number, width = 120): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
  };
}
