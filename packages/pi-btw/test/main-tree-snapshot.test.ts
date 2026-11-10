import assert from "node:assert/strict";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { prepareTreeSnapshot } from "../src/main-tree-picker.js";

function messageNode(id: string, content: unknown): SessionTreeNode {
  return {
    entry: {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content, timestamp: 0 },
    },
    children: [],
  } as SessionTreeNode;
}

test("snapshot keeps immutable text fragments instead of materializing multi-block copy text", () => {
  const first = { type: "text", text: "  raw\u001b[2J " };
  const second = { type: "text", text: "tail\n" };
  const blocks = [first, { type: "image", data: "ignored" }, second];
  const node = messageNode("entry", blocks);
  const snapshot = prepareTreeSnapshot([node]);
  const source = snapshot.rawCopyText.get("entry");

  assert.deepEqual(source, ["  raw\u001b[2J ", "tail\n"]);
  assert.notEqual(source, blocks);
  first.text = "changed";
  blocks.push({ type: "text", text: "new progress" });
  assert.deepEqual(source, ["  raw\u001b[2J ", "tail\n"]);
  assert.deepEqual(snapshot.rawCopyText.get("entry"), source, "reading a source must not replace it with a cache");
});

test("snapshot uses a string for one text block and omits whitespace and non-text sources", () => {
  const snapshot = prepareTreeSnapshot([
    messageNode("single", [{ type: "text", text: "raw\u001b[2J" }]),
    messageNode("empty", [{ type: "text", text: "" }]),
    messageNode("blank", [
      { type: "text", text: " \t" },
      { type: "text", text: "\n\u00a0\ufeff" },
    ]),
    messageNode("image", [{ type: "image", data: "ignored" }]),
  ]);

  assert.deepEqual([...snapshot.rawCopyText], [["single", "raw\u001b[2J"]]);
});

test("snapshot copy eligibility preserves ECMAScript whitespace and non-whitespace controls", () => {
  const whitespace =
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const blankNodes = [...whitespace].map((character, index) =>
    messageNode(`blank-${index}`, [
      { type: "text", text: character },
      { type: "text", text: " " },
    ]),
  );
  assert.equal(prepareTreeSnapshot(blankNodes).rawCopyText.size, 0);
  for (const character of ["\u0085", "\u200b", "\u001b"]) {
    const snapshot = prepareTreeSnapshot([messageNode("control", [{ type: "text", text: character }])]);
    assert.equal(snapshot.rawCopyText.get("control"), character);
  }
});

test("snapshot stores only defined labels or timestamps, including empty and timestamp-only values", () => {
  const nodes = Array.from({ length: 1000 }, (_, index) => messageNode(`entry-${index}`, "text"));
  nodes[1].label = "saved\u001b[2J";
  nodes[2].labelTimestamp = "timestamp\u001b";
  nodes[3].label = "";
  nodes[3].labelTimestamp = "";
  const snapshot = prepareTreeSnapshot(nodes);

  assert.equal(snapshot.savedLabels.size, 3);
  assert.deepEqual(
    [...snapshot.savedLabels],
    [
      ["entry-1", { label: "saved[2J", labelTimestamp: undefined }],
      ["entry-2", { label: undefined, labelTimestamp: "timestamp" }],
      ["entry-3", { label: "", labelTimestamp: "" }],
    ],
  );
  assert.equal(snapshot.savedLabels.has("entry-0"), false);
  assert.equal(nodes[1].label, "saved\u001b[2J");
  assert.equal(nodes[2].labelTimestamp, "timestamp\u001b");
});
