import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { PiApplyGate } from "../src/daemon/apply-gate.js";
import { withTempHome as withRawTempHome } from "./helpers.js";

function withTempHome(run: (root: string) => Promise<void>) {
  return withRawTempHome(async (root) => {
    await fs.promises.mkdir(root, { recursive: true });
    await run(root);
  });
}

for (const external of [false, true])
  test(`daemon grant reserves the actual Pi edit queue${external ? " outside its agent root" : ""} across read-modify-write`, () =>
    withTempHome(async (root) => {
      const target = path.join(external ? path.dirname(root) : root, "AGENTS.md");
      await fs.promises.writeFile(target, "remote-before\nbase\n");
      const gate = new PiApplyGate(() => {});
      const token = await gate.acquire("operation", [target]);
      let observed!: () => void;
      const realpathObserved = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const original = fs.promises.realpath;
      fs.promises.realpath = (async (...args: Parameters<typeof original>) => {
        const value = await original(...args);
        if (String(args[0]) === target) observed();
        return value;
      }) as typeof original;
      syncBuiltinESMExports();
      let read = false;
      const tool = createEditTool(root, {
        operations: {
          access: async (file) => {
            read = true;
            await fs.promises.access(file);
          },
          readFile: (file) => fs.promises.readFile(file),
          writeFile: (file, content) => fs.promises.writeFile(file, content),
        },
      });
      const edit = tool.execute("pi-edit", { path: target, edits: [{ oldText: "base", newText: "local" }] });
      try {
        await realpathObserved;
        await setImmediate(); // Drain queue-key resolution after the filesystem callback.
        assert.equal(read, false);
        await fs.promises.writeFile(target, "remote-after\nbase\n");
        await gate.release(token);
        await edit;
        assert.equal(await fs.promises.readFile(target, "utf8"), "remote-after\nlocal\n");
        assert.equal(gate.size, 0);
      } finally {
        fs.promises.realpath = original;
        syncBuiltinESMExports();
        if (gate.size) await gate.release(token);
        await edit;
      }
    }));

test("a canonical external-session target uses the actual Pi queue without granting a write", () =>
  withTempHome(async (root) => {
    const target = path.join(path.dirname(root), "external-sessions", "session.jsonl");
    await fs.promises.mkdir(path.dirname(target));
    await fs.promises.writeFile(target, "unchanged");
    const gate = new PiApplyGate(() => {});
    const token = await gate.acquire("external-session", [target]);
    try {
      assert.equal(gate.size, 1);
      assert.equal(await fs.promises.readFile(target, "utf8"), "unchanged");
    } finally {
      await gate.release(token);
    }
  }));

test("a stale generation refuses a grant and unexpected live-owner loss keeps an acquired grant", () =>
  withTempHome(async (root) => {
    const target = path.join(root, "AGENTS.md");
    await fs.promises.writeFile(target, "unchanged");
    let current = true;
    const gate = new PiApplyGate(() => {
      if (!current) throw new Error("stale generation");
    });
    const token = await gate.acquire("first", [target]);
    assert.equal(await gate.acquire("first", [target]), token);
    current = false;
    await assert.rejects(gate.acquire("second", [target]), /stale generation/u);
    await assert.rejects(gate.releaseAfterOwnerExit(process.pid), /still alive/u);
    assert.equal(gate.size, 1);
    await gate.release(token);
    assert.equal(gate.size, 0);
  }));

test("prompt cancellation after a grant does not release an unobserved remote writer", () =>
  withTempHome(async (root) => {
    const target = path.join(root, "AGENTS.md");
    await fs.promises.writeFile(target, "unchanged");
    const gate = new PiApplyGate(() => {});
    const controller = new AbortController();
    const token = await gate.acquire("job", [target], controller.signal);
    controller.abort();
    assert.equal(gate.size, 1);
    await gate.release(token);
    assert.equal(gate.size, 0);
  }));

test("invalid mutation targets and changed duplicate requests are refused", () =>
  withTempHome(async (root) => {
    const target = path.join(root, "AGENTS.md");
    await fs.promises.writeFile(target, "unchanged");
    const gate = new PiApplyGate(() => {});
    for (const targets of [
      [],
      ["relative"],
      ["nul\0path"],
      [42 as unknown as string],
      Array<string>(16_385).fill(target),
    ])
      await assert.rejects(gate.acquire("invalid", targets), /Invalid/u);
    const token = await gate.acquire("same", [target]);
    try {
      await assert.rejects(gate.acquire("same", [path.join(root, "settings.json")]), /changed/u);
    } finally {
      await gate.release(token);
    }
  }));
