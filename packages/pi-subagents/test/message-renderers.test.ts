import assert from "node:assert/strict";
import {
  initTheme,
  type MessageRenderer,
  type MessageRenderOptions,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { BROKER_MESSAGE_TYPE, COMPLETION_MESSAGE_TYPE, registerMessageRenderers } from "../src/message-renderers.js";

initTheme("dark", false);

const messageTypes = [
  { customType: COMPLETION_MESSAGE_TYPE, summary: "Subagent job completion" },
  { customType: BROKER_MESSAGE_TYPE, summary: "Subagent message" },
] as const;

function getRenderer(customType: string): MessageRenderer {
  const mock = createMockPi();
  registerMessageRenderers(mock.pi);
  const renderer = mock.messageRenderers.get(customType);
  assert.ok(renderer);
  return renderer as MessageRenderer;
}

function createTheme() {
  const fg = vi.fn((_role: string, text: string) => text);
  const theme = {
    fg,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  return { theme, fg };
}

function createMessage(customType: string, content: Parameters<MessageRenderer>[0]["content"] = "Private body") {
  return {
    role: "custom" as const,
    customType,
    content,
    display: true,
    details: { requestId: "req_1", jobId: "job_1" },
    timestamp: 0,
  };
}

for (const { customType, summary } of messageTypes) {
  test.each([
    { name: "default", key: "ctrl+o" },
    { name: "non-default", key: "ctrl+shift+o" },
    { name: "multiple", key: "ctrl+o/ctrl+shift+o" },
    { name: "host-formatted", key: "ctrl+//option+o" },
    { name: "unbound", key: "" },
  ])(`${customType} uses the injected $name expansion key`, ({ key }) => {
    const renderer = getRenderer(customType);
    const { theme, fg } = createTheme();
    const keyText = vi.fn((_action: string) => key);
    const keyHint = vi.fn(() => "unused keyHint");
    const message = createMessage(customType);
    const before = JSON.stringify(message);
    const component = renderer(message, { expanded: false, outputPad: 1, keyText, keyHint }, theme);
    assert.ok(component);
    const text = component.render(100).join("\n");

    assert.deepEqual(keyText.mock.calls, [["app.tools.expand"]]);
    assert.equal(keyHint.mock.calls.length, 0);
    assert.ok(text.includes(summary));
    assert.doesNotMatch(text, /Private body|unused keyHint/u);
    if (key) {
      const hint = ` (${key} to expand)`;
      assert.ok(text.includes(`${summary}${hint}`));
      assert.ok(fg.mock.calls.some(([role, value]) => (role === "dim" || role === "muted") && value === hint));
    } else {
      assert.doesNotMatch(text, /to expand|\(\)/u);
    }
    assert.equal(JSON.stringify(message), before);
  });

  test(`${customType} omits the hint on older hosts without injected helpers`, () => {
    const renderer = getRenderer(customType);
    const { theme } = createTheme();
    const legacyOptions = { expanded: false, outputPad: 1 } as MessageRenderOptions;
    const component = renderer(createMessage(customType), legacyOptions, theme);
    assert.ok(component);
    const text = component.render(100).join("\n");
    assert.ok(text.includes(summary));
    assert.doesNotMatch(text, /to expand|Private body/u);
  });

  test.each(["keyText only", "keyHint only"])(`${customType} handles a host with %s`, (helpers) => {
    const renderer = getRenderer(customType);
    const { theme } = createTheme();
    const keyText = vi.fn((_action: string) => "ctrl+shift+o");
    const keyHint = vi.fn(() => "to expand without a bound key");
    // Older hosts can supply only part of the current renderer options contract.
    const options = {
      expanded: false,
      outputPad: 1,
      ...(helpers === "keyText only" ? { keyText } : { keyHint }),
    } as unknown as MessageRenderOptions;
    const component = renderer(createMessage(customType), options, theme);
    assert.ok(component);
    const text = component.render(100).join("\n");
    assert.ok(text.includes(summary));
    assert.equal(keyHint.mock.calls.length, 0);
    if (helpers === "keyText only") {
      assert.deepEqual(keyText.mock.calls, [["app.tools.expand"]]);
      assert.match(text, /ctrl\+shift\+o to expand/u);
    } else {
      assert.doesNotMatch(text, /to expand/u);
    }
  });

  test.each(["string", "text blocks"])(`${customType} preserves expanded %s content`, (contentType) => {
    const renderer = getRenderer(customType);
    const { theme } = createTheme();
    const raw = "Security: untrusted child content\nFull child message\u0007\u001b[31m\u202e\u2066";
    const content =
      contentType === "string"
        ? raw
        : [
            { type: "text" as const, text: raw },
            { type: "image" as const, data: "image payload must not render", mimeType: "image/png" },
            { type: "text" as const, text: "Second text block" },
          ];
    const message = createMessage(customType, content);
    const before = JSON.stringify(message);
    const keyText = vi.fn(() => {
      throw new Error("Expanded messages must not format key hints");
    });
    const keyHint = vi.fn(() => {
      throw new Error("Expanded messages must not format key hints");
    });
    const component = renderer(message, { expanded: true, outputPad: 1, keyText, keyHint }, theme);
    assert.ok(component);
    const text = component.render(100).join("\n");

    assert.match(text, /Security: untrusted child content/u);
    assert.match(text, /Full child message/u);
    if (contentType !== "string") assert.match(text, /Second text block/u);
    assert.doesNotMatch(text, /to expand|image payload/u);
    assert.equal(text.includes("\u001b[31m"), false);
    for (const control of ["\u0007", "\u202e", "\u2066"]) assert.equal(text.includes(control), false);
    assert.equal(keyText.mock.calls.length, 0);
    assert.equal(keyHint.mock.calls.length, 0);
    assert.equal(JSON.stringify(message), before);
  });

  for (const expanded of [false, true]) {
    test.each([
      { name: "ASCII", content: "Long untrusted child content that must wrap.", widths: [0, 1, 2, 4, 8, 20, 80] },
      {
        name: "wide text",
        content: "Untrusted 日本語 👩‍💻 e\u0301 text that must wrap.",
        // Pi cannot fit a two-cell grapheme into one cell; preserve its wrapping policy.
        widths: [0, 2, 4, 8, 20, 80],
      },
    ])(
      `${customType} preserves $name width bounds and invalidation when expanded=${expanded}`,
      ({ content, widths }) => {
        const renderer = getRenderer(customType);
        const { theme } = createTheme();
        const component = renderer(
          createMessage(customType, content),
          { expanded, outputPad: 4, keyText: () => "ctrl+shift+o", keyHint: () => "unused keyHint" },
          theme,
        );
        assert.ok(component);
        const original = component.render(100);
        for (const width of widths) {
          const lines = component.render(width);
          if (width === 0) assert.deepEqual(lines, []);
          for (const line of lines) assert.ok(visibleWidth(line) <= width, `${customType}: ${width}-cell overflow`);
        }
        component.invalidate();
        assert.deepEqual(component.render(100), original);
      },
    );
  }
}
