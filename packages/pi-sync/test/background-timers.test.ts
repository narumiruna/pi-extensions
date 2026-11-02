import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";

test("background startup deadlines are unreferenced and repeated stop clears them", async () => {
  const { createStartupCheck } = await import("../src/sync/startup-check.js");
  const check = createStartupCheck(
    {} as Parameters<typeof createStartupCheck>[0],
    {} as Parameters<typeof createStartupCheck>[1],
  );
  const context = createMockContext({ mode: "rpc" });
  const timeouts = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");

  try {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      check.start(context.ctx, new AbortController().signal);
      const result = timeouts.mock.results.at(-1);
      assert.equal(result?.type, "return");
      if (result?.type !== "return") throw new Error("Missing startup deadline");
      assert.equal(result.value.hasRef(), false);
      assert.equal(timeouts.mock.calls.at(-1)?.[1], 30_000);

      // Stop before the detached task begins; no settings or network work is needed.
      await check.stop();
      await check.stop();
      assert.ok(cleared.mock.calls.some(([timer]) => timer === result.value));
    }
  } finally {
    await check.stop();
  }
});
