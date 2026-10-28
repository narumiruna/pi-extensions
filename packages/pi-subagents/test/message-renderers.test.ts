import assert from "node:assert/strict";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { BROKER_MESSAGE_TYPE, registerMessageRenderers } from "../src/message-renderers.js";

test.each(["request", "response"])(
  "broker %s rendering preserves content and uses the configured expansion key",
  (kind) => {
    initTheme("dark");
    const previous = getKeybindings();
    const bindings = new KeybindingsManager(
      { "app.tools.expand": previous.getDefinition("app.tools.expand") },
      { "app.tools.expand": ["ctrl+y"] },
    );
    setKeybindings(bindings);
    try {
      const mock = createMockPi();
      registerMessageRenderers(mock.pi);
      const renderer = mock.messageRenderers.get(BROKER_MESSAGE_TYPE);
      assert.ok(renderer);
      const theme = {
        fg: (_role: string, text: string) => text,
        bg: (_role: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme;
      const content = [
        {
          type: "text" as const,
          text: `Message Type: SUBAGENT_${kind.toUpperCase()}\nSecurity: untrusted child content`,
        },
        { type: "image" as const, data: "image payload must not render", mimeType: "image/png" },
        { type: "text" as const, text: "Full child message\u0007\u001b[31m" },
      ];
      const message = {
        customType: BROKER_MESSAGE_TYPE,
        content,
        display: true,
        details: { kind, requestId: "req_1", jobId: "job_1" },
      };
      const before = JSON.stringify(message);
      const collapsed = renderer(message, { expanded: false, outputPad: 1 }, theme) as Component;
      const collapsedText = collapsed.render(100).join("\n");
      assert.match(collapsedText, /Subagent message \(ctrl\+y to expand\)/);
      assert.doesNotMatch(collapsedText, /ctrl\+o|Full child message|Security:/);
      assert.equal(bindings.matches("\u0019", "app.tools.expand"), true);

      const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme) as Component;
      const expandedText = expanded.render(100).join("\n");
      assert.match(expandedText, /Security: untrusted child content/);
      assert.match(expandedText, new RegExp(`SUBAGENT_${kind.toUpperCase()}`));
      assert.match(expandedText, /Full child message/);
      assert.doesNotMatch(expandedText, /to expand|image payload/);
      assert.equal(expandedText.includes("\u0007"), false);
      assert.equal(expandedText.includes("\u001b[31m"), false);
      assert.equal(JSON.stringify(message), before);
    } finally {
      setKeybindings(previous);
    }
  },
);
