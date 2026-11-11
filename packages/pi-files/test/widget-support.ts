import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";

export function createPendingWidget(
  value: unknown,
  theme: Pick<Theme, "fg"> = { fg: (_role, text) => text },
): Component & { dispose?(): void } {
  assert.equal(typeof value, "function");
  return (value as (tui: undefined, theme: Pick<Theme, "fg">) => Component & { dispose?(): void })(undefined, theme);
}

export function widgetClick(component: Component, x: number, y: number, height: number, width = 120) {
  const event: TuiMouseEvent = {
    type: "press",
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
  component.handleMouse?.(event);
  component.handleMouse?.({ ...event, type: "release" });
  return component.handleMouse?.({ ...event, type: "click" });
}
