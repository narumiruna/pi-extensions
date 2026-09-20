import assert from "node:assert/strict";
import { test } from "vitest";
import { callErrorReporter, notifyInteractionError } from "../src/interaction-error.js";
import { sanitizeTerminalText } from "../src/terminal-text.js";
import { safeMenuText } from "../src/text.js";
import type { MenuContext } from "../src/types.js";

const ctx: MenuContext = { mode: "print", hasUI: false, ui: {} };

for (const outcome of ["absent", "success", "resolved", "throw", "rejected"] as const) {
  test(`error reporter preserves the callback receiver and payload: ${outcome}`, async () => {
    const error = new Error("original");
    const calls: unknown[][] = [];
    const options = {
      onError:
        outcome === "absent"
          ? undefined
          : function (this: unknown, currentCtx: MenuContext, failure: unknown) {
              calls.push([this, currentCtx, failure]);
              if (outcome === "throw") throw new Error("reporter failed");
              if (outcome === "rejected") return Promise.reject(new Error("reporter failed"));
              if (outcome === "resolved") return Promise.resolve();
            },
    };
    const reporting = callErrorReporter(ctx, options, error);
    assert.deepEqual(calls, outcome === "absent" ? [] : [[options, ctx, error]]);
    if (outcome === "absent" || outcome === "throw") {
      assert.equal(reporting, false);
    } else {
      assert.ok(reporting);
      if (outcome === "rejected") {
        await assert.rejects(async () => reporting.completion, /reporter failed/u);
      } else {
        assert.equal(await reporting.completion, undefined);
      }
    }
  });
}

test("error reporter returns the original pending completion without chaining a promise", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reporting = callErrorReporter(ctx, { onError: () => gate }, "failure");
  assert.ok(reporting);
  assert.equal(reporting.completion, gate);
  let settled = false;
  const waiting = Promise.resolve(reporting.completion).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await waiting;
  assert.equal(settled, true);
});

const hostile = "  bad\x1b[31m\x1b]0;title\x07\n\ttext\x00\x9b2J\u202e  ";
for (const [sanitize, expected] of [
  [safeMenuText, "bad [31m ]0;title text 2J\u202e"],
  [sanitizeTerminalText, "  bad  text  "],
] as const) {
  for (const error of [new Error(hostile), hostile, { toString: () => hostile }]) {
    test(`notification preserves ${sanitize.name} output for ${typeof error === "string" ? "string" : error instanceof Error ? "Error" : "object"}`, () => {
      const notifications: unknown[][] = [];
      const ui = {
        notify(this: unknown, ...args: unknown[]) {
          notifications.push([this, ...args]);
        },
      };
      notifyInteractionError({ mode: "rpc", hasUI: true, ui }, error, "Exact label: ", sanitize);
      assert.deepEqual(notifications, [[ui, `Exact label: ${expected}`, "error"]]);
      if (error instanceof Error) assert.equal(error.message, hostile);
    });
  }
}

for (const failure of ["notifier", "sanitizer"] as const) {
  test(`notification suppresses a throwing ${failure}`, () => {
    let calls = 0;
    const ui = {
      notify() {
        calls += 1;
        throw new Error("notifier unavailable");
      },
    };
    assert.doesNotThrow(() =>
      notifyInteractionError({ mode: "rpc", hasUI: true, ui }, new Error("original"), "Label: ", (message) => {
        if (failure === "sanitizer") throw new Error("sanitizer unavailable");
        return safeMenuText(message);
      }),
    );
    assert.equal(calls, failure === "notifier" ? 1 : 0);
  });
}
