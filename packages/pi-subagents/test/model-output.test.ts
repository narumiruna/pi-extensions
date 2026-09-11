import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MAX_MODEL_TEXT_BYTES,
  MAX_MODEL_TEXT_LINES,
  modelVisibleJson,
  truncateModelText,
} from "../src/model-output.js";

test("sanitizes and truncates model-visible text by bytes and lines", () => {
  const byteLimited = truncateModelText(`\u001b[31m${'"\\'.repeat(40 * 1024)}`);
  assert.equal(byteLimited.includes(String.fromCharCode(27)), false);
  assert.ok(Buffer.byteLength(byteLimited, "utf8") <= MAX_MODEL_TEXT_BYTES);
  assert.match(byteLimited, /… \[truncated\]$/u);

  const lineLimited = truncateModelText(
    Array.from({ length: MAX_MODEL_TEXT_LINES + 10 }, (_, index) => `line ${index}`).join("\n"),
  );
  assert.ok(lineLimited.split("\n").length <= MAX_MODEL_TEXT_LINES);
  assert.match(lineLimited, /… \[truncated\]$/u);

  const fullyLimited = truncateModelText(`${"\n".repeat(MAX_MODEL_TEXT_LINES - 1)}${"x".repeat(60 * 1024)}`);
  assert.ok(Buffer.byteLength(fullyLimited, "utf8") <= MAX_MODEL_TEXT_BYTES);
  assert.ok(fullyLimited.split("\n").length <= MAX_MODEL_TEXT_LINES);
});

test("truncates JSON only after serialized expansion", () => {
  const raw = '"\\'.repeat(16 * 1024);
  assert.ok(Buffer.byteLength(raw, "utf8") < MAX_MODEL_TEXT_BYTES);
  const serialized = modelVisibleJson({ result: raw }, { indent: 2 });
  assert.ok(Buffer.byteLength(serialized, "utf8") <= MAX_MODEL_TEXT_BYTES);
  assert.match(serialized, /… \[truncated\]$/u);
});
