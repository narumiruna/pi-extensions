import assert from "node:assert/strict";
import { test } from "vitest";
import { JsonLineDecoder } from "../src/rpc-line-decoder.js";

function harness() {
  const values: unknown[] = [];
  let malformed = 0;
  const decoder = new JsonLineDecoder(
    (value) => values.push(value),
    () => {
      malformed++;
    },
  );
  return { decoder, values, malformed: () => malformed };
}

for (const split of [false, true]) {
  test(`invalid UTF-8 loses only its frame, not terminal events in ${split ? "later" : "the same"} chunks`, () => {
    const h = harness();
    const invalid = Buffer.from([0xff, 0x0a]);
    const terminal = Buffer.from('{"type":"message_end"}\n{"type":"agent_settled"}\n');
    if (split) {
      h.decoder.push(invalid);
      h.decoder.push(terminal);
    } else h.decoder.push(Buffer.concat([invalid, terminal]));
    h.decoder.finish();
    assert.deepEqual(h.values, [{ type: "message_end" }, { type: "agent_settled" }]);
    assert.equal(h.malformed(), 1);
  });
}

test("all byte partitions preserve UTF-8 text and use only LF as framing", () => {
  const value = { text: "字😀\u2028\u2029" };
  const frame = Buffer.from(`${JSON.stringify(value)}\r\n`);
  for (let index = 1; index < frame.length; index++) {
    const h = harness();
    h.decoder.push(frame.subarray(0, index));
    h.decoder.push(frame.subarray(index));
    h.decoder.finish();
    assert.deepEqual(h.values, [value]);
    assert.equal(h.malformed(), 0);
  }
});

test("a malformed fragmented frame does not corrupt preceding or following valid frames", () => {
  const h = harness();
  h.decoder.push(Buffer.concat([Buffer.from('1\n{"text":"'), Buffer.from([0xf0, 0x9f])]));
  h.decoder.push(Buffer.concat([Buffer.from([0xff]), Buffer.from('"}\n2\n')]));
  h.decoder.push("3\n");
  h.decoder.finish();
  assert.deepEqual(h.values, [1, 2, 3]);
  assert.equal(h.malformed(), 1);
});

for (const fragmented of [false, true]) {
  test(`oversized ${fragmented ? "fragmented" : "complete"} frames are counted once and recover at LF`, () => {
    const h = harness();
    if (fragmented) {
      h.decoder.push("x".repeat(128 * 1024));
      h.decoder.push("x".repeat(128 * 1024 + 1));
      h.decoder.push("still oversized");
      h.decoder.push("\n1\n");
    } else h.decoder.push(`${"x".repeat(256 * 1024 + 1)}\n1\n`);
    h.decoder.finish();
    assert.deepEqual(h.values, [1]);
    assert.equal(h.malformed(), 1);
  });
}

test("the byte limit accepts a complete maximum-size frame and bounds multibyte fragments", () => {
  const h = harness();
  const value = "a".repeat(256 * 1024 - 2);
  h.decoder.push(`${JSON.stringify(value)}\n`);
  h.decoder.push(`"${"字".repeat(88_000)}`);
  h.decoder.push('"\ntrue\n');
  assert.deepEqual(h.values, [value, true]);
  assert.equal(h.malformed(), 1);
});

for (const partial of ['{"text":"字"}', "bad", Buffer.from([0xf0, 0x9f]), "x".repeat(256 * 1024 + 1)]) {
  test(`finish handles an unterminated ${typeof partial === "string" ? partial.slice(0, 16) : "UTF-8"} frame once`, () => {
    const h = harness();
    h.decoder.push(partial);
    h.decoder.finish();
    h.decoder.finish();
    const valid = typeof partial === "string" && partial.startsWith("{");
    assert.deepEqual(h.values, valid ? [{ text: "字" }] : []);
    assert.equal(h.malformed(), valid ? 0 : 1);
    h.decoder.push("false\n");
    assert.deepEqual(h.values.at(-1), false);
  });
}

test("blank lines, CRLF, malformed JSON, and subsequent JSON retain their boundaries", () => {
  const h = harness();
  h.decoder.push('\n\r\n  \nnot-json\n{"ok":true}\r\n');
  h.decoder.finish();
  assert.deepEqual(h.values, [{ ok: true }]);
  assert.equal(h.malformed(), 1);
});
