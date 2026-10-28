import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createVirtualRead } from "../src/read.js";

const ctx = { cwd: "/host-cwd" } as ExtensionToolContext;
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
it.each([
  ["one\ntwo\nthree", undefined, undefined],
  ["one\ntwo\nthree", 2, 1],
  ["one\ntwo\nthree", 3, undefined],
  ["\uFEFFone\r\ntwo\r\n", 1, 2],
  ["", undefined, undefined],
] as const)("keeps Pi text paging semantics for %j offset=%j limit=%j", async (text, offset, limit) => {
  const operations = { access: async () => {}, readFile: async () => Buffer.from(text) };
  const input = { path: "/virtual-file", offset, limit };
  const core = await createReadToolDefinition("/", { operations }).execute("core", input, undefined, undefined, ctx);
  const own = await createVirtualRead(operations).execute("own", input, undefined, undefined, ctx);
  expect(own).toEqual(core);
});
it("never invokes host access or image detection and preserves exact virtual filenames", async () => {
  const probe = vi.spyOn(fs, "access").mockRejectedValue(new Error("Host access is forbidden"));
  syncBuiltinESMExports();
  const access = vi.fn(async () => {});
  const readFile = vi.fn(async () => Buffer.from("AgentFS text"));
  const detectImageMimeType = vi.fn(async () => "image/png");
  const path = "/a'b 1 PM.é.png";
  const result = await createVirtualRead({ access, readFile, detectImageMimeType }).execute(
    "id",
    { path },
    undefined,
    undefined,
    ctx,
  );
  expect(result.structuredContent).toBe("AgentFS text");
  expect(access).toHaveBeenCalledExactlyOnceWith(path);
  expect(readFile).toHaveBeenCalledExactlyOnceWith(path);
  expect(probe).not.toHaveBeenCalled();
  expect(detectImageMimeType).not.toHaveBeenCalled();
});
it("bounds complete output including notices and supplies a usable next offset", async () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
  const operations = { access: async () => {}, readFile: async () => Buffer.from(text) };
  const tool = createVirtualRead(operations);
  const first = await tool.execute("id", { path: "/x" }, undefined, undefined, ctx);
  const content = first.content[0];
  expect(content.type).toBe("text");
  if (content.type !== "text") throw new Error("Expected text");
  expect(content.text.split("\n").length).toBeLessThanOrEqual(2000);
  expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(50 * 1024);
  const next = Number(content.text.match(/offset=(\d+)/)?.[1]);
  expect(next).toBeGreaterThan(1);
  const second = await tool.execute("id", { path: "/x", offset: next }, undefined, undefined, ctx);
  expect(second.structuredContent).toBe(
    text
      .split("\n")
      .slice(next - 1)
      .join("\n"),
  );
});
it("reports an oversized first line without placing it in model or structured output", async () => {
  const tool = createVirtualRead({ access: async () => {}, readFile: async () => Buffer.from("x".repeat(100_000)) });
  const result = await tool.execute("id", { path: "/x" }, undefined, undefined, ctx);
  expect(result.structuredContent).toMatch(/Line 1.*exceeds/);
  expect(JSON.stringify(result.content).length).toBeLessThan(500);
});
it.each([{ offset: 0 }, { offset: 1.5 }, { limit: -1 }, { limit: Number.NaN }])(
  "rejects invalid paging %j",
  async (input) => {
    const tool = createVirtualRead({ access: async () => {}, readFile: async () => Buffer.from("x") });
    await expect(tool.execute("id", { path: "/x", ...input }, undefined, undefined, ctx)).rejects.toThrow(
      /positive integer/,
    );
  },
);
it("reports missing files, out-of-range offsets, and cancellation between operations", async () => {
  const controller = new AbortController();
  const readFile = vi.fn(async () => Buffer.from("x"));
  const tool = createVirtualRead({
    access: async () => {
      controller.abort();
    },
    readFile,
  });
  await expect(tool.execute("id", { path: "/x" }, controller.signal, undefined, ctx)).rejects.toThrow(/aborted/);
  expect(readFile).not.toHaveBeenCalled();
  const normal = createVirtualRead({ access: async () => {}, readFile });
  await expect(normal.execute("id", { path: "/x", offset: 2 }, undefined, undefined, ctx)).rejects.toThrow(
    /beyond end/,
  );
  const missing = createVirtualRead({
    access: async () => {
      throw new Error("ENOENT");
    },
    readFile,
  });
  await expect(missing.execute("id", { path: "/x" }, undefined, undefined, ctx)).rejects.toThrow(/ENOENT/);
});
