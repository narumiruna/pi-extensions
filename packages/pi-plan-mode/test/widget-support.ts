import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type WidgetFactory = (_tui: never, theme: Theme) => Component;

const IDENTITY_THEME = {
  fg: (_role: string, text: string) => text,
} as unknown as Theme;

export function renderMockWidget(value: unknown, width = 80): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "function") throw new Error("Expected a widget factory or string array");
  return (value as WidgetFactory)(undefined as never, IDENTITY_THEME).render(width);
}
