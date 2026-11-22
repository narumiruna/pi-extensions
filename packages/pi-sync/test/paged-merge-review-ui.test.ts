import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { confirmMergeReview } from "../src/ui/merge-review.js";

initTheme("dark", false);

const summary = ["3 local files change. Exact details required."];
const approve = "Yes, apply changes";

for (const second of ["No, cancel", approve]) {
  test(`RPC shows exact read-only details and starts again at No before ${second}`, async () => {
    const content = [
      "  preserve  whitespace  ",
      ...Array.from({ length: 32 }, (_, index) => `exact path ${index}`),
    ].join("\n");
    const confirmations: { title: string; choices: string[] }[] = [];
    const detailTitles: string[] = [];
    let loads = 0;
    let custom = 0;
    const { ctx } = createMockContext({
      mode: "rpc",
      custom: async () => custom++,
      select: async (title: string, choices: string[]) => {
        if (choices.includes("View details")) {
          confirmations.push({ title, choices });
          return confirmations.length === 1 ? "View details" : second;
        }
        detailTitles.push(title);
        return choices.includes("Next") ? "Next" : "Back";
      },
    });
    assert.equal(
      await confirmMergeReview(
        ctx,
        "Apply?",
        async () => {
          loads++;
          return content;
        },
        undefined,
        () => true,
        undefined,
        summary,
      ),
      second === approve,
    );
    assert.equal(loads, 1);
    assert.equal(custom, 0);
    assert.match(confirmations[0]?.title ?? "", /3 local files change/u);
    assert.deepEqual(
      confirmations.map(({ choices }) => choices),
      [
        ["No, cancel", "View details", "Done"],
        ["No, cancel", approve, "View details", "Done"],
      ],
    );
    assert.deepEqual(
      detailTitles.flatMap((page) => page.split("\n").filter((line) => /whitespace|^exact path/u.test(line))),
      content.split("\n"),
    );
  });
}

for (const exit of ["summary", "rpc replacement"] as const) {
  test(`${exit} cancels the review without approval`, async () => {
    let current = true;
    let loads = 0;
    let selects = 0;
    const { ctx } = createMockContext({
      mode: "rpc",
      select: async () => {
        selects++;
        return exit === "summary" ? "No, cancel" : "View details";
      },
    });
    assert.equal(
      await confirmMergeReview(
        ctx,
        "Apply?",
        async () => {
          loads++;
          current = false;
          return "exact";
        },
        undefined,
        () => current,
        undefined,
        summary,
      ),
      false,
    );
    assert.equal(selects, 1);
    assert.equal(loads, exit === "summary" ? 0 : 1);
  });
}

for (const exit of ["q", "\u0003", "dispose", "back"] as const) {
  test(`TUI detail load drains and preserves safe approval on ${JSON.stringify(exit)}`, async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<string>();
    const screenCount = exit === "back" ? 4 : 2;
    let calls = 0;
    let aborted = false;
    let drained = false;
    let unexpected: number | undefined;
    const frames: string[][] = [];
    const bindings: Record<string, string> = {
      "tui.select.down": "j",
      "tui.select.confirm": "l",
      "tui.select.cancel": "q",
    };
    const { ctx } = createMockContext({
      mode: "tui",
      custom: async (factory: unknown) => {
        const stage = ++calls;
        if (stage > screenCount) {
          unexpected = stage;
          return undefined;
        }
        const ready = Promise.withResolvers<Awaited<ReturnType<typeof factoryAsFunction>>>();
        const factoryAsFunction = factory as (...args: unknown[]) => Promise<{
          render(width: number): string[];
          handleInput(data: string): void;
          dispose(): void;
        }>;
        const harness = createCustomSelectorHarness(
          (...args: unknown[]) => {
            void factoryAsFunction(...args).then(ready.resolve, ready.reject);
            return { render: () => [], handleInput() {} };
          },
          48,
          {
            matches: (data, action) => data === bindings[action],
            getKeys: (action) => (bindings[action] ? [bindings[action]] : []),
          },
        );
        const component = await ready.promise;
        try {
          frames.push(component.render(48));
          if (stage === 1) {
            component.handleInput("j");
            component.handleInput("l");
          } else if (stage === 2) {
            await started.promise;
            if (exit === "dispose") {
              component.dispose();
              harness.dispose();
            } else if (exit === "back") {
              pending.resolve("  exact path  \nother path");
            } else component.handleInput(exit);
          } else {
            component.handleInput(stage === 3 ? "q" : "l");
          }
          return await harness.resultPromise;
        } finally {
          component.dispose();
          harness.dispose();
        }
      },
    });
    const result = await confirmMergeReview(
      ctx,
      "Apply?",
      async (signal) => {
        if (!signal) throw new Error("No detail owner signal");
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            pending.reject(signal.reason);
          },
          { once: true },
        );
        started.resolve();
        try {
          return await pending.promise;
        } finally {
          drained = true;
        }
      },
      undefined,
      () => true,
      undefined,
      summary,
    );
    assert.equal(result, false);
    assert.equal(calls, screenCount);
    assert.equal(unexpected, undefined);
    if (exit !== "back") assert.equal(aborted, true);
    assert.equal(drained, true);
    assert.ok(frames.flat().every((row) => visibleWidth(row) <= 48));
    assert.match(frames[0]?.join("\n") ?? "", /→ No, cancel/u);
    assert.doesNotMatch(frames[0]?.join("\n") ?? "", /Yes,/u);
    assert.match(frames[1]?.join("\n") ?? "", /Loading exact sync details/u);
    if (exit === "back") {
      assert.match(frames[2]?.join("\n") ?? "", / {2}exact path {2}/u);
      assert.doesNotMatch(frames[2]?.join("\n") ?? "", /Yes,/u);
      assert.match(frames[3]?.join("\n") ?? "", /→ No, cancel/u);
      assert.match(frames[3]?.join("\n") ?? "", /Yes, apply changes/u);
    }
  });
}
