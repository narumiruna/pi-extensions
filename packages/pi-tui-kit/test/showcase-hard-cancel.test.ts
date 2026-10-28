import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsConfig } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { demoHasHardCancel } from "../scripts/showcase/hard-cancel.js";
import { runThemeDemo } from "../scripts/showcase/theme-demo.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

const actions = [
  "tui.altScreen.search",
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.lineUp",
  "tui.altScreen.lineDown",
  "tui.altScreen.previousPrompt",
  "tui.altScreen.nextPrompt",
  "tui.altScreen.top",
  "tui.altScreen.bottom",
] as const;

for (const action of actions) {
  test(`theme demo refuses host-owned Ctrl+C for ${action} before mounting`, async (t) => {
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      bindings: { [action]: "ctrl+c" } as KeybindingsConfig,
    });
    t.onTestFinished(() => fixture.stop());
    await runThemeDemo(fixture.ctx as ExtensionCommandContext, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    assert.equal(fixture.editor.getValue(), "main draft");
    assert.match(fixture.notifications[0]?.message ?? "", /needs Ctrl\+C for hard cancellation/u);
    assert.throws(() => fixture.component, /not mounted/u);
    assert.equal(demoHasHardCancel(fixture.host, true), action !== "tui.altScreen.search");
  });
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} fixed hard-cancel admission follows native matcher behavior`, (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      bindings: { "tui.altScreen.search": "ctrl+shift+c" },
      kitty: true,
    });
    t.onTestFinished(() => fixture.stop());
    // Shift+Ctrl+C is distinct under the native protocol, not a Ctrl+C blocker.
    assert.equal(demoHasHardCancel(fixture.host, true), true);
    assert.equal(demoHasHardCancel(fixture.host, false), true);
  });
}
