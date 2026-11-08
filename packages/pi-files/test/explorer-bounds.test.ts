import { expect, test } from "vitest";
import { FileQuoteExplorer } from "../src/file-context-explorer.js";

// Every specialized mode must respect the same zero-cell display boundary.
test.each(["files", "contents", "preview", "preview-help", "history", "revision", "diff"])(
  "renders no cells for unusable widths in %s mode",
  (mode) => {
    const unexpectedRender = () => {
      throw new Error("An unusable viewport must not render themed content");
    };
    const component = new FileQuoteExplorer({
      tui: { terminal: { rows: 24 }, requestRender() {} } as never,
      theme: { fg: unexpectedRender, bg: unexpectedRender, bold: unexpectedRender } as never,
      keybindings: { matches: () => false, getKeys: () => [] } as never,
      files: ["example.ts"],
      loadFile: async () => ({ path: "example.ts", lines: ["exact text"] }),
      done() {},
    });
    Object.assign(component, { mode });
    try {
      for (const width of [0, -1, 0.9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(component.render(width)).toEqual([]);
      }
    } finally {
      component.dispose();
    }
  },
);
