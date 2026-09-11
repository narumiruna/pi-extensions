import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMockContext as baseContext, createCustomSelectorHarness } from "../../../test/support.js";

/** Drive the real setup review through its confirmation binding; keep other root mock behavior. */
export function createMockContext(overrides: Record<string, unknown> = {}) {
  const result = baseContext(overrides);
  const select = overrides.select as ((title: string, options: string[]) => Promise<string | undefined>) | undefined;
  if (!select) return result;
  const ctx = result.ctx as ExtensionCommandContext;
  const original = ctx.ui.custom;
  ctx.ui.custom = (async (factory, options) => {
    // Kit's custom-interaction runner uses an async factory; its secret-input driver owns it.
    if (factory.constructor.name === "AsyncFunction" && overrides.custom) {
      return (overrides.custom as typeof original)(factory, options);
    }
    const harness = createCustomSelectorHarness(factory, 160, undefined, 200);
    const frame = stripVTControlCharacters(harness.render().join("\n"));
    const label =
      /enter (Save setup|Save sync setup|Save storage connection|Add sync setup|Add storage connection)/u.exec(
        frame,
      )?.[1];
    if (!label || !harness.isPiTuiKitScreen || /^\s*→/mu.test(frame)) {
      harness.dispose();
      return original(factory, options);
    }
    try {
      const choice = await select(frame, [label, "Cancel"]);
      harness.handleInput(
        choice === label ? "tui.select.confirm" : choice === "\u0003" ? "\u0003" : "tui.select.cancel",
      );
      return harness.result;
    } finally {
      harness.dispose();
    }
  }) as typeof original;
  return result;
}
