import { expect, test } from "vitest";
import { prepareDiffDocument } from "../scripts/showcase/diff-document.js";

test.each([
  { before: "", after: "new\n", marker: "+new" },
  { before: "old\n", after: "", marker: "-old" },
  { before: "value \n", after: "value  \n", marker: "+value  " },
  { before: "same\n", after: "same", marker: "\\ No newline at end of file" },
  { before: "same\r\n", after: "same\n", marker: "-same\r" },
])("produces a unified patch for exact text: $marker", ({ before, after, marker }) => {
  const result = prepareDiffDocument(before, after);
  expect(result.kind).toBe("diff");
  expect(result.content).toMatch(/--- a\/settings\.toml\n\+\+\+ b\/settings\.toml\n@@/u);
  expect(result.content.split("\n")).toContain(marker);
});

test("includes three matching context lines on either side, and omits the rest", () => {
  const surrounding = [
    "skip L",
    "context L1",
    "context L2",
    "context L3",
    "%s",
    "context R1",
    "context R2",
    "context R3",
    "skip R",
  ];
  const text = (changed: string) => `${surrounding.map((line) => line.replace("%s", changed)).join("\n")}\n`;
  const result = prepareDiffDocument(text("old"), text("new"));
  expect(result.content).toContain("@@ -2,7 +2,7 @@");
  expect(result.content).not.toMatch(/skip [LR]/u);
});

test("distinguishes identical text from a preview that exceeds a bound", () => {
  expect(prepareDiffDocument("same\r\n", "same\r\n")).toEqual({ kind: "text", content: "No differences." });
  const overBudget = { kind: "text", content: "Comparison exceeds the preview limit." };
  const inputTooLarge = "你".repeat(22_000);
  expect(prepareDiffDocument(inputTooLarge, inputTooLarge)).toEqual(overBudget);
  expect(prepareDiffDocument(`${"a".repeat(32_767)}\n`, `${"b".repeat(32_767)}\n`)).toEqual(overBudget);
  expect(prepareDiffDocument("", "x\n".repeat(1_025))).toEqual(overBudget);
});
