import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type MenuContext,
  runConfirmation,
  runCustomInteraction,
  runDocumentReview,
  runLiveChoice,
  runMultiSelect,
  runQuestionnaire,
  runTask,
} from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

type ErrorOptions = {
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: MenuContext, error: unknown): void | Promise<void>;
};

const runners = [
  {
    name: "confirmation",
    prefix: "Confirmation failed: ",
    guardNotification: true,
    run: (ctx: MenuContext, options: ErrorOptions, fail: () => never) =>
      runConfirmation(ctx, { title: "Confirm", message: "Proceed?", ...options, onUnsupportedMode: fail }),
  },
  {
    name: "questionnaire",
    prefix: "Questionnaire failed: ",
    guardNotification: true,
    run: (ctx: MenuContext, options: ErrorOptions, fail: () => never) =>
      runQuestionnaire(ctx, {
        questions: [{ id: "scope", header: "Scope", prompt: "Which?", options: [{ label: "One" }] }],
        ...options,
        onUnsupportedMode: fail,
      }),
  },
  {
    name: "document review",
    prefix: "Document review failed: ",
    guardNotification: true,
    run: (ctx: MenuContext, options: ErrorOptions, fail: () => never) =>
      runDocumentReview(ctx, { title: "Review", content: "body", ...options, onUnsupportedMode: fail }),
  },
  {
    name: "multi-select",
    prefix: "Multi-select failed: ",
    guardNotification: true,
    run: (ctx: MenuContext, options: ErrorOptions, fail: () => never) =>
      runMultiSelect(ctx, { title: "Select", items: [], ...options, onUnsupportedMode: fail }),
  },
  {
    name: "live choice",
    prefix: "Live choice failed: ",
    guardNotification: true,
    run: (ctx: MenuContext, options: ErrorOptions, fail: () => never) =>
      runLiveChoice(ctx, { title: "Select", items: [], ...options, onUnsupportedMode: fail }),
  },
  {
    name: "custom interaction",
    prefix: "Custom interaction failed: ",
    guardNotification: false,
    run: (ctx: MenuContext, options: ErrorOptions, fail: () => never) =>
      runCustomInteraction(ctx, { create: fail, ...options, onUnsupportedMode: fail }),
  },
  {
    name: "task",
    prefix: "Task failed: ",
    guardNotification: false,
    run: (ctx: MenuContext, options: ErrorOptions, fail: () => never) =>
      runTask(ctx, { label: "Working", task: fail, ...options }),
  },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function failureContext(mode: MenuContext["mode"], error: unknown, beforeFailure = () => {}) {
  const notifications: unknown[][] = [];
  const fail = (): never => {
    beforeFailure();
    throw error;
  };
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      select: fail,
      custom: fail,
      notify: (...args: unknown[]) => {
        notifications.push(args);
      },
    },
  };
  return { ctx, fail, notifications };
}

for (const runner of runners) {
  describe(runner.name, () => {
    for (const mode of ["tui", "rpc", "print", "json"] as const) {
      for (const reporter of ["absent", "success", "throw", "reject"] as const) {
        test(`${mode}: ${reporter} reporter preserves the original error and exact notification`, async () => {
          const error = new Error("  bad\x1b[31m\x1b]0;title\x07\n\ttext\x00\x9b2J\u202e  ");
          const { ctx, fail, notifications } = failureContext(mode, error);
          const calls: unknown[][] = [];
          const result = await runner.run(
            ctx,
            {
              onError:
                reporter === "absent"
                  ? undefined
                  : (currentCtx, failure) => {
                      calls.push([currentCtx, failure]);
                      if (reporter === "throw") throw new Error("reporter unavailable");
                      if (reporter === "reject") return Promise.reject(new Error("reporter unavailable"));
                    },
            },
            fail,
          );
          assert.deepEqual(result, { kind: "error", error });
          assert.equal(result.kind === "error" && result.error, error);
          assert.deepEqual(calls, reporter === "absent" ? [] : [[ctx, error]]);
          const expected = runner.name === "questionnaire" ? "  bad  text  " : "bad [31m ]0;title text 2J\u202e";
          assert.deepEqual(
            notifications,
            ctx.hasUI && reporter !== "success" ? [[`${runner.prefix}${expected}`, "error"]] : [],
          );
        });
      }
    }

    test("a throwing notifier cannot replace the typed error", async () => {
      const error = new Error("original");
      const { ctx, fail } = failureContext("rpc", error);
      let notifications = 0;
      ctx.ui.notify = () => {
        notifications += 1;
        throw new Error("notifier unavailable");
      };
      assert.deepEqual(await runner.run(ctx, {}, fail), { kind: "error", error });
      assert.equal(notifications, 1);
    });

    for (const transition of ["stale", "abort", "no UI"] as const) {
      for (const outcome of ["success", "reject"] as const) {
        for (const mode of ["tui", "rpc"] as const) {
          test(`${mode}: ${transition} during a pending ${outcome} reporter preserves local policy`, async () => {
            const error = new Error("original");
            const { ctx, fail, notifications } = failureContext(mode, error);
            const started = deferred();
            const release = deferred();
            const owner = new AbortController();
            let current = true;
            let settled = false;
            let callbackCalls = 0;
            const running = runner
              .run(
                ctx,
                {
                  signal: owner.signal,
                  isCurrent: () => current,
                  onError: async () => {
                    callbackCalls += 1;
                    started.resolve();
                    await release.promise;
                    if (outcome === "reject") throw new Error("reporter unavailable");
                  },
                },
                fail,
              )
              .then((result) => {
                settled = true;
                return result;
              });
            await started.promise;
            assert.equal(settled, false);
            assert.deepEqual(notifications, []);
            if (transition === "stale") current = false;
            if (transition === "abort") owner.abort();
            if (transition === "no UI") ctx.hasUI = false;
            release.resolve();
            assert.deepEqual(await running, transition === "no UI" ? { kind: "error", error } : { kind: "stale" });
            assert.equal(callbackCalls, 1);
            assert.deepEqual(
              notifications,
              outcome === "reject" && transition !== "no UI" && !runner.guardNotification
                ? [[`${runner.prefix}original`, "error"]]
                : [],
            );
          });
        }
      }
    }

    for (const transition of ["stale", "abort"] as const) {
      test(`${transition} before reporting suppresses callback and notification`, async () => {
        const owner = new AbortController();
        let current = true;
        const { ctx, fail, notifications } = failureContext("rpc", new Error("obsolete"), () => {
          if (transition === "stale") current = false;
          else owner.abort();
        });
        let calls = 0;
        assert.deepEqual(
          await runner.run(
            ctx,
            {
              signal: owner.signal,
              isCurrent: () => current,
              onError: () => {
                calls += 1;
              },
            },
            fail,
          ),
          { kind: "stale" },
        );
        assert.equal(calls, 0);
        assert.deepEqual(notifications, []);
      });
    }
  });
}

for (const transition of ["cancel", "dispose", "owner abort"] as const) {
  test(`task execution ${transition} while reporting retains its distinct result`, async () => {
    const tui = createTuiHarness();
    const { ctx, notifications } = failureContext("tui", new Error("unused"));
    const owner = new AbortController();
    const started = deferred();
    const release = deferred();
    const running = runTask(
      { ...ctx, ui: { ...ctx.ui, custom: tui.custom } },
      {
        label: "Working",
        signal: owner.signal,
        task: async () => {
          throw new Error("original");
        },
        onError: async () => {
          started.resolve();
          await release.promise;
          throw new Error("reporter unavailable");
        },
      },
    );
    await tui.waitForOpen();
    await started.promise;
    if (transition === "cancel") tui.press("ctrl+c");
    else if (transition === "dispose") await tui.dispose();
    else owner.abort();
    release.resolve();
    assert.deepEqual(await running, { kind: transition === "cancel" ? "cancelled" : "stale" });
    assert.deepEqual(notifications, [["Task failed: original", "error"]]);
  });
}
