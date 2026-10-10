import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { confirmMergeReview } from "../src/ui/merge-review.js";

const defaultKeys = { up: "\u001b[A", down: "\u001b[B", confirm: "\r", cancel: "\u001b" };
const remappedKeys = { up: "k", down: "j", confirm: "l", cancel: "q" };
type Keys = typeof defaultKeys;
type Component = { render(width: number): string[]; handleInput(data: string): void; dispose?(): void };

function tuiDriver(scripts: readonly (readonly string[])[], keys: Keys, width = 80, rows = 40) {
  const frames: string[][] = [];
  let calls = 0;
  const bindings: Record<string, string> = {
    "tui.select.up": keys.up,
    "tui.select.down": keys.down,
    "tui.select.confirm": keys.confirm,
    "tui.select.cancel": keys.cancel,
  };
  const context = createMockContext({
    mode: "tui",
    custom: async (factory: unknown) => {
      const script = scripts[calls++];
      if (!script) throw new Error("Unexpected screen");
      let resolve!: (component: Component) => void;
      let reject!: (error: unknown) => void;
      const ready = new Promise<Component>((success, failure) => {
        resolve = success;
        reject = failure;
      });
      const harness = createCustomSelectorHarness(
        (...args: unknown[]) => {
          Promise.resolve((factory as (...args: unknown[]) => unknown)(...args)).then(
            (value) => resolve(value as Component),
            reject,
          );
          return { render: () => [], handleInput() {} };
        },
        width,
        {
          matches: (data, action) => data === bindings[action],
          getKeys: (action) =>
            bindings[action]
              ? [
                  action === "tui.select.confirm" && keys === defaultKeys
                    ? "enter"
                    : action === "tui.select.cancel" && keys === defaultKeys
                      ? "escape"
                      : bindings[action],
                ]
              : [],
        },
        rows,
      );
      const component = await ready;
      frames.push(component.render(width));
      for (const data of script) {
        if (data === "dispose") {
          component.dispose?.();
          return undefined;
        }
        component.handleInput(data);
        frames.push(component.render(width));
      }
      const result = await harness.resultPromise;
      component.dispose?.();
      return result;
    },
  });
  return { ctx: context.ctx, frames, calls: () => calls };
}

for (const keys of [defaultKeys, remappedKeys]) {
  for (const [name, script, confirmed] of [
    ["safe default", [keys.confirm], false],
    ["explicit approval", [keys.down, keys.confirm], true],
    ["cancel", [keys.cancel], false],
    ["hard cancel", ["\u0003"], false],
  ] as const) {
    test(`confirmation ${name} with ${keys === defaultKeys ? "default" : "remapped"} keys`, async () => {
      const driver = tuiDriver([script], keys);
      assert.equal(
        await confirmMergeReview(
          driver.ctx,
          "Update 1 local file?",
          "full details",
          undefined,
          () => true,
          "update local file",
          ["Local: APPEND_SYSTEM.md"],
        ),
        confirmed,
      );
      const frame = driver.frames[0].join("\n");
      assert.match(frame, /→ No, cancel/);
      assert.match(frame, /Yes, update local file/);
      assert.match(frame, /View details/);
      assert.ok(driver.frames.flat().every((line) => visibleWidth(line) <= 80));
    });
  }
  test(`optional details return resets No with ${keys === defaultKeys ? "default" : "remapped"} keys`, async () => {
    const driver = tuiDriver(
      [[keys.down, keys.down, keys.confirm], [keys.confirm, keys.down, keys.cancel], [keys.confirm]],
      keys,
    );
    assert.equal(
      await confirmMergeReview(
        driver.ctx,
        "Update?",
        "  exact spaces\nDelete obsolete.md\nremote updates",
        undefined,
        () => true,
        "apply changes",
        ["Summary"],
      ),
      false,
    );
    assert.equal(driver.calls(), 3);
    const details = driver.frames.find((frame) => frame.some((line) => line.includes("exact spaces")));
    assert.ok(details?.some((line) => line.includes("  exact spaces")));
    assert.ok(!details?.some((line) => line.includes("Yes,")));
    assert.match(driver.frames.at(-1)?.join("\n") ?? "", /→ No, cancel/);
  });
}

for (const exit of ["\u0003", "dispose"]) {
  test(`details ${JSON.stringify(exit)} cancels the whole flow`, async () => {
    const driver = tuiDriver([[defaultKeys.down, defaultKeys.down, defaultKeys.confirm], [exit]], defaultKeys);
    assert.equal(await confirmMergeReview(driver.ctx, "Update?", "detail", undefined, () => true), false);
    assert.equal(driver.calls(), 2);
  });
}

test("external confirmation disposal cannot approve", async () => {
  const driver = tuiDriver([["dispose"]], defaultKeys);
  assert.equal(await confirmMergeReview(driver.ctx, "Update?", "detail", undefined, () => true), false);
});

test("RPC exposes optional paginated read-only details and a fresh confirmation", async () => {
  const pages: string[] = [];
  const choicesSeen: string[][] = [];
  let mainCalls = 0;
  let customCalls = 0;
  const context = createMockContext({
    mode: "rpc",
    custom: async () => {
      customCalls++;
    },
    select: async (title: string, choices: string[]) => {
      pages.push(title);
      choicesSeen.push(choices);
      if (choices.includes("View details")) return ++mainCalls === 1 ? "View details" : "Yes, apply changes";
      return choices.includes("Next") ? "Next" : "Back";
    },
  });
  assert.equal(
    await confirmMergeReview(
      context.ctx,
      "Update?",
      Array.from({ length: 30 }, (_, index) => `change ${index}`).join("\n"),
      undefined,
      () => true,
    ),
    true,
  );
  assert.equal(customCalls, 0);
  assert.equal(mainCalls, 2);
  assert.match(pages.join("\n"), /change 0/);
  assert.match(pages.join("\n"), /change 29/);
  assert.equal(choicesSeen[0][0], "No, cancel");
  assert.ok(
    choicesSeen
      .filter((choices) => !choices.includes("View details"))
      .every((choices) => !choices.some((choice) => choice.startsWith("Yes,"))),
  );
});

for (const stage of ["confirmation", "details"] as const) {
  for (const invalidation of ["abort", "replace"] as const) {
    test(`${invalidation} during ${stage} cannot authorize transfer`, async () => {
      const controller = new AbortController();
      let current = true;
      const context = createMockContext({
        mode: "rpc",
        select: async (_title: string, choices: string[]) => {
          if (stage === "details" && choices.includes("View details")) return "View details";
          if (invalidation === "abort") controller.abort();
          else current = false;
          return choices.includes("View details") ? "Yes, apply changes" : "Back";
        },
      });
      assert.equal(await confirmMergeReview(context.ctx, "Update?", "detail", controller.signal, () => current), false);
    });
  }
}

for (const mode of ["print", "json"] as const) {
  test(`${mode} rejects review without custom UI`, async () => {
    let calls = 0;
    const context = createMockContext({
      mode,
      custom: async () => {
        calls++;
      },
    });
    await assert.rejects(
      confirmMergeReview(context.ctx, "Update?", "detail", undefined, () => true),
      /requires observable TUI or RPC/,
    );
    assert.equal(calls, 0);
  });
}

test("UI failure cannot authorize transfer", async () => {
  const context = createMockContext({
    mode: "rpc",
    select: async () => {
      throw new Error("UI unavailable");
    },
  });
  await assert.rejects(
    confirmMergeReview(context.ctx, "Update?", "detail", undefined, () => true),
    /no transfer was performed/,
  );
});

test("pre-aborted owner does not open a screen", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const context = createMockContext({
    mode: "rpc",
    select: async () => {
      calls++;
    },
  });
  assert.equal(await confirmMergeReview(context.ctx, "Update?", "detail", controller.signal, () => true), false);
  assert.equal(calls, 0);
});

for (const width of [1, 8, 20, 40]) {
  test(`narrow confirmation stays within ${width} cells`, async () => {
    const driver = tuiDriver([[defaultKeys.confirm]], defaultKeys, width, 16);
    assert.equal(
      await confirmMergeReview(
        driver.ctx,
        "Update long-path files?",
        "full details",
        undefined,
        () => true,
        "update local files",
        ["Local: " + "長".repeat(100)],
      ),
      false,
    );
    assert.ok(driver.frames.flat().every((line) => visibleWidth(line) <= width));
  });
}

test("long exact details can scroll to the last path without an approval action", async () => {
  const driver = tuiDriver(
    [
      [defaultKeys.down, defaultKeys.down, defaultKeys.confirm],
      ["\u001b[F", defaultKeys.cancel],
      [defaultKeys.confirm],
    ],
    defaultKeys,
    20,
    16,
  );
  const body =
    Array.from({ length: 30 }, (_, index) => `Update ${index}-${"長".repeat(40)}.md`).join("\n") + "\nFINAL_PATH.md";
  assert.equal(
    await confirmMergeReview(driver.ctx, "Update?", body, undefined, () => true, "update local files", [
      "Local: 30 updates",
    ]),
    false,
  );
  assert.ok(driver.frames.some((frame) => frame.some((line) => line.includes("FINAL_PATH.md"))));
  assert.ok(driver.frames.flat().every((line) => visibleWidth(line) <= 20));
});

test("invalid RPC choice never authorizes transfer", async () => {
  let calls = 0;
  const context = createMockContext({
    mode: "rpc",
    select: async () => (++calls === 1 ? "Yes, unoffered action" : "No, cancel"),
  });
  assert.equal(await confirmMergeReview(context.ctx, "Update?", "details", undefined, () => true), false);
  assert.equal(calls, 2);
});

test("failure in optional details cannot authorize transfer", async () => {
  let calls = 0;
  const context = createMockContext({
    mode: "rpc",
    select: async () => {
      if (++calls === 1) return "View details";
      throw new Error("details unavailable");
    },
  });
  await assert.rejects(
    confirmMergeReview(context.ctx, "Update?", "details", undefined, () => true),
    /no transfer was performed/,
  );
});

test("conflict review keeps its action-specific continuation label", async () => {
  const titles: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    select: async (title: string, choices: string[]) => {
      titles.push(title);
      return choices.find((choice) => choice === "Yes, Continue to resolution choices");
    },
  });
  assert.equal(
    await confirmMergeReview(
      context.ctx,
      "Review private conflict versions",
      "Unresolved: AGENTS.md",
      undefined,
      () => true,
      "Continue to resolution choices",
    ),
    true,
  );
  assert.match(titles[0], /Unresolved: AGENTS.md/);
});
