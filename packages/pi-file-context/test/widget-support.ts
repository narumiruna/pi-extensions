import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export function createPendingWidget(
  value: unknown,
  theme: Pick<Theme, "fg"> = { fg: (_role, text) => text },
): Component {
  assert.equal(typeof value, "function");
  return (value as (tui: undefined, theme: Pick<Theme, "fg">) => Component)(undefined, theme);
}
