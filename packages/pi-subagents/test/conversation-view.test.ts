import assert from "node:assert/strict";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { conversationView, displayMarkdown } from "../src/conversation-view.js";

initTheme("dark", false);

function createTheme() {
  let color = "\u001b[31m";
  const fg = vi.fn((_role: string, text: string) => `${color}${text}`);
  return {
    theme: { fg } as unknown as Theme,
    fg,
    setColor(value: string) {
      color = value;
    },
  };
}

const source = "Body marker\n\n```ts\nconst count = 1;\n```";

test("Markdown views retain one instance and reuse unchanged rendered output", () => {
  const { theme, fg } = createTheme();
  const render = vi.spyOn(Markdown.prototype, "render");
  try {
    const view = displayMarkdown(theme, source);
    const first = view.render(80);
    const styled = fg.mock.calls.length;
    assert.ok(styled > 0);
    assert.deepEqual(view.render(80), first);
    assert.equal(fg.mock.calls.length, styled, "unchanged redraw must reuse the Markdown cache");
    assert.equal(new Set(render.mock.contexts).size, 1);

    view.render(40);
    const resized = fg.mock.calls.length;
    assert.ok(resized > styled, "resize must render for the new width");
    view.render(40);
    assert.equal(fg.mock.calls.length, resized);
    view.invalidate();
    view.render(40);
    assert.ok(fg.mock.calls.length > resized, "invalidation must refresh styled output");
    assert.equal(new Set(render.mock.contexts).size, 1, "resize and invalidation must retain the instance");
  } finally {
    render.mockRestore();
  }
});

test("nested conversation views forward invalidation to cached Markdown", () => {
  const { theme, setColor } = createTheme();
  const invalidate = vi.spyOn(Markdown.prototype, "invalidate");
  try {
    const view = conversationView([conversationView([displayMarkdown(theme, source)])]);
    const first = view.render(80).join("\n");
    assert.ok(first.includes("\u001b[31mBody marker"));
    setColor("\u001b[32m");
    assert.equal(view.render(80).join("\n"), first, "theme changes require invalidation");
    view.invalidate();
    assert.equal(invalidate.mock.calls.length, 1);
    const refreshed = view.render(80).join("\n");
    assert.ok(refreshed.includes("\u001b[32mBody marker"));
    assert.ok(!refreshed.includes("\u001b[31mBody marker"));
  } finally {
    invalidate.mockRestore();
  }
});

test("Markdown caches belong to each display view", () => {
  const { theme } = createTheme();
  const render = vi.spyOn(Markdown.prototype, "render");
  try {
    const first = displayMarkdown(theme, source);
    const second = displayMarkdown(theme, "Other body");
    const expected = second.render(80);
    first.render(80);
    assert.deepEqual(second.render(80), expected);
    first.invalidate();
    first.render(80);
    assert.deepEqual(second.render(80), expected);
    assert.equal(new Set(render.mock.contexts).size, 2);
  } finally {
    render.mockRestore();
  }
});

test("cached Markdown retains sanitation and width bounds across resize and invalidation", () => {
  const { theme } = createTheme();
  const raw = "日本語 👩‍💻 e\u0301\u001b]0;PRIVATE\u0007\u202e\n\n```text\n  exact code\n```";
  const view = conversationView([displayMarkdown(theme, raw)]);
  for (const width of [0, 1, 2, 4, 8, 20, 80, Number.NaN]) {
    const first = view.render(width);
    assert.deepEqual(view.render(width), first);
    view.invalidate();
    assert.deepEqual(view.render(width), first);
    if (width === 0 || Number.isNaN(width)) assert.deepEqual(first, []);
    for (const line of first) assert.ok(visibleWidth(line) <= width);
    assert.doesNotMatch(first.join("\n"), /PRIVATE|\p{Bidi_Control}/u);
  }
});
