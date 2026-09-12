import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot/snapshot-codec.js";
import { snapshot } from "./helpers.js";

test("snapshot codec preserves portable selection intent and rejects malformed policy", async () => {
  const selected = {
    ...snapshot([]),
    selection: { version: 1 as const, include: ["settings.json", "pi-starship.toml"] },
  };
  assert.deepEqual(await decodeSnapshot(await encodeSnapshot(selected)), selected);

  const malformed = {
    ...snapshot([]),
    selection: { version: 1, include: ["../auth.json"] },
  };
  await assert.rejects(
    decodeSnapshot(gzipSync(Buffer.from(JSON.stringify(malformed)))),
    /selection|sync\.include|safe agent-relative/i,
  );
});

test("snapshot decoding bounds decompressed output and honors cancellation", async () => {
  const encoded = gzipSync(
    Buffer.from(JSON.stringify(snapshot([{ path: "settings.json", content: Buffer.from("x".repeat(4096)) }]))),
  );
  await assert.rejects(
    decodeSnapshot(encoded, { maxOutputLength: 1024 }),
    /maxOutputLength|larger than|buffer|exceeds/i,
  );

  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(
    decodeSnapshot(encoded, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  const activeController = new AbortController();
  const expanding = decodeSnapshot(gzipSync(Buffer.alloc(16 * 1024 * 1024)), {
    signal: activeController.signal,
  });
  activeController.abort(new DOMException("disposed", "AbortError"));
  await assert.rejects(expanding, (error: unknown) => error instanceof Error && error.name === "AbortError");
});
