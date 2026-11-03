import { awaitWithContext, BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { createPiLangfuseDurableConversation } from "../src/durable.js";
import { deferred, fixture } from "./durable-support.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it.each(["harness", "cancel", "dispose", "runtime"] as const)(
  "does not report an observer error for normal %s closure",
  async (kind) => {
    const f = await fixture(cleanup);
    const observation = withCancel(context);
    const errors: string[] = [];
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context: observation.context,
      onError: (stage) => {
        errors.push(stage);
      },
    });
    if (kind === "harness") await f.harness.close(context);
    else if (kind === "cancel") observation.cancel();
    else if (kind === "dispose") await Promise.all([tracing.dispose(), tracing.dispose()]);
    else await f.runtime.shutdown();
    await tracing.closed;
    await tracing.dispose();
    await f.harness.close(context);
    expect(errors).toEqual([]);
    expect(tracing.active).toBe(false);
    expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
  },
);

it("reports a genuine failed Session once without exporting its storage error", async () => {
  const f = await fixture(cleanup);
  const errors: string[] = [];
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
    onError: (stage) => {
      errors.push(stage);
    },
  });
  vi.spyOn(f.storage, "commit").mockRejectedValueOnce(new Error("PRIVATE-STORAGE-FAILURE"));
  await expect(f.root.commit((tx) => tx.appendEntry(f.root.id, { kind: "host.failed" }), context)).rejects.toThrow();
  expect((await f.harness.closed).kind).toBe("failed");
  await tracing.closed;
  expect(errors).toEqual(["observer closure"]);
  expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE");
  expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
});

it("cancels its closure join without joining or canceling a host-owned storage close", async () => {
  const entered = deferred();
  const release = deferred();
  let storageClosed = false;
  class GatedStorage extends MemoryStorage {
    override async close(ctx: Parameters<MemoryStorage["close"]>[0]) {
      entered.resolve();
      await awaitWithContext(release.promise, ctx);
      storageClosed = true;
      return super.close(ctx);
    }
  }
  const f = await fixture(cleanup, new GatedStorage());
  cleanup.push(async () => release.resolve());
  const observation = withCancel(context);
  const errors: string[] = [];
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context: observation.context,
    onError: (stage) => {
      errors.push(stage);
    },
  });
  const closing = f.harness.close(context);
  await entered.promise;
  observation.cancel();
  await tracing.closed;
  expect(storageClosed).toBe(false);
  release.resolve();
  await closing;
  expect(errors).toEqual([]);
});
