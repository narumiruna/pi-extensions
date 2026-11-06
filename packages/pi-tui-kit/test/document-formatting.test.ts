import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Markdown } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { formatDocumentPresentation } from "../src/components/document-formatting.js";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

for (const [name, line, expected] of [
  ["plain quote", "│ text", "  text"],
  ["nested quotes", "│ │ text", "    text"],
  ["single space", " │ text", "   text"],
  ["single tab", "\t│ text", "\t  text"],
  ["indentation", " \t│ text", " \t  text"],
  ["Unicode whitespace", "\u00a0│ text", "\u00a0  text"],
  ["dash marker", "- │ text", "-   text"],
  ["plus marker", "+ │ text", "+   text"],
  ["asterisk marker", "* │ text", "*   text"],
  ["ordered period marker", "12. │ text", "12.   text"],
  ["ordered parenthesis marker", "12) │ text", "12)   text"],
  ["mixed containers", " \t* \t12)  - │ │ text", " \t* \t12)  -     text"],
  ["ANSI styles", "\u001b[31m- \u001b[39m│ text", "-   text"],
  ["empty line", "", ""],
  ["ordinary text", "text │ quote", "text │ quote"],
  ["missing marker whitespace", "-│ text", "-│ text"],
  ["missing ordered delimiter", "12 │ text", "12 │ text"],
  ["missing ordered whitespace", "12)│ text", "12)│ text"],
  ["missing quote whitespace", "│text", "│text"],
  ["literal border after quote", "│ │text", "  │text"],
  ["no quote border", "* \t12) text", "* \t12) text"],
] as const) {
  test(`Markdown search prefix preserves ${name}`, () => {
    vi.spyOn(Markdown.prototype, "render").mockReturnValue([line]);
    for (const includeSearchMetadata of [false, true]) {
      const presentation = formatDocumentPresentation(
        "unused",
        { kind: "markdown", renderMermaid: false },
        80,
        theme,
        includeSearchMetadata,
      );
      assert.deepEqual(presentation.lines, [line]);
      assert.deepEqual(presentation.searchLines, [expected]);
    }
  });
}

test("Markdown search prefix handles long non-matching whitespace and list markers", async (t) => {
  const formatter = pathToFileURL(resolve("packages/pi-tui-kit/dist/components/document-formatting.js")).href;
  const probe = `
import assert from "node:assert/strict";
import { Markdown } from "@earendil-works/pi-tui";
const { formatDocumentPresentation } = await import(process.argv[1]);
const theme = { fg: (_role, text) => text, bold: (text) => text };
const lines = [
  "*" + "\\t\\t*".repeat(10_000) + "x│ text",
  " ".repeat(50_000) + "x│ text",
  "- " + " ".repeat(50_000) + "x│ text",
  "1. ".repeat(10_000) + "x│ text",
  "9".repeat(50_000) + "x│ text",
];
process.send("ready");
for (const line of lines) {
  Markdown.prototype.render = () => [line];
  const presentation = formatDocumentPresentation("unused", { kind: "markdown", renderMermaid: false }, 80, theme);
  assert.deepEqual(presentation.searchLines, [line]);
}
process.disconnect();
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", probe, formatter], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  t.onTestFinished(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  await new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("message", (message) => {
      if (message !== "ready") {
        reject(new Error(`Unexpected Markdown prefix probe message: ${String(message)}`));
        return;
      }
      ready = true;
      // Exclude module loading from the deadline and kill a regressed blocking match.
      deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Markdown search prefix matching exceeded its deadline"));
      }, 1_000);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (ready && code === 0) done();
      else reject(new Error(`Markdown prefix probe failed (${code}, ${signal}): ${stderr}`));
    });
  });
});
