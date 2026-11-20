import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type CommitPublication,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type HarnessSettings,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { expect, vi } from "vitest";
import { createLangfuseRuntimeFromBackend } from "../src/durable.js";
import { durableCommit, durableSnapshot } from "../src/durable-state.js";
import { FakeBackend, type FakeObservation } from "./support.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function metadata(span: FakeObservation) {
  return Object.assign({}, span.attributes.metadata, ...span.updates.map((update) => update.metadata));
}
export function named(backend: FakeBackend, name: string) {
  const span = backend.observations.find((candidate) => candidate.name === name);
  if (!span) throw new Error(`Missing ${name}`);
  return span;
}
export async function fixture(
  cleanup: Array<() => Promise<unknown>>,
  storage = new MemoryStorage(),
  settings: HarnessSettings = {},
) {
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 }, ...settings } },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  cleanup.push(() => runtime.shutdown().catch(() => undefined));
  return { faux, registry, storage, harness, root, backend, runtime };
}

/** Collect immutable publications from real public Harness work, not removed event fixtures. */
export async function recordedWork(cleanup: Array<() => Promise<unknown>>) {
  const f = await fixture(cleanup);
  const view = await f.harness.observeConversation(f.root.id, { advance() {}, end() {} }, context);
  const snapshot = durableSnapshot(view.value);
  const publications: CommitPublication[] = [];
  const stored = f.harness.observeCommits({
    advance(publication) {
      publications.push(publication);
    },
    end() {},
  });
  f.registry.install(
    defineExtension({
      name: "review",
      tools: [
        defineTool({
          name: "review",
          description: "Review tool",
          parameters: Type.Object({ value: Type.String() }),
          execute: async ({ value }) => ({ output: [fauxText(value)] }),
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("review", { value: "tool result" }, { id: "review-call" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("final answer"),
  ]);
  const submission = await f.root.submit({ type: "input", content: "prompt", requestId: "primary" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  await f.harness.waitForIdle(context);
  await vi.waitFor(() =>
    expect(publications.some((p) => p.changes.some((c) => c.type === "submission" && c.value.status === "done"))).toBe(
      true,
    ),
  );
  stored.detach();
  view.detach();
  return { ...f, snapshot, submission, commits: publications.map((p) => durableCommit(p, f.root.id)) };
}
