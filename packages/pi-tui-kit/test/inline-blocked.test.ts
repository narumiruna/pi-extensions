import assert from "node:assert/strict";
import { type ExtensionContext, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runCustomInteraction } from "../src/custom-interaction.js";
import { runQuestionnaire } from "../src/questionnaire.js";
import { runTask } from "../src/task.js";
import { createTuiHarness } from "../src/testing/tui-harness.js";
import { deferred } from "./fixtures/renderer-host.js";

type Custom = ExtensionContext["ui"]["custom"];
type CustomOptions = Parameters<Custom>[1];
type Blocked = NonNullable<CustomOptions>["blocked"];

initTheme("dark");

// Use Pi's real inline stack/custom/reset methods without opening a terminal.
// Only unrelated reset services and the status transport are mocked.
function createInlineHost() {
  const mounted = deferred<void>();
  const statuses: Blocked[] = [];
  const options: CustomOptions[] = [];
  let text = "original draft";
  let doneCalls = 0;
  const editor = { getText: () => text, setText: (value: string) => (text = value) };
  const noop = () => {};
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    editor,
    defaultEditor: {},
    keybindings: getKeybindings(),
    extensionDialogs: [],
    editorContainer: { clear: noop, addChild: noop },
    programStatus: {
      setBlocked(_source: string, status: Blocked) {
        statuses.push(status ? { ...status } : undefined);
        if (host.extensionDialogs.length) mounted.resolve();
      },
    },
    ui: { terminal: { rows: 24 }, setFocus: noop, requestRender: noop, hideOverlay: noop },
    clearExtensionTerminalInputListeners: noop,
    setExtensionFooter: noop,
    setExtensionHeader: noop,
    clearExtensionWidgets: noop,
    footerDataProvider: { clearExtensionStatuses: noop },
    footer: { invalidate: noop },
    setCustomEditorComponent: noop,
    setupAutocompleteProvider: noop,
    updateTerminalTitle: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
  }) as {
    extensionDialogs: Array<{ component: Component & { dispose?(): void } }>;
    showExtensionCustom: Custom;
    resetExtensionUI(): void;
  };
  const custom: Custom = (factory, currentOptions) => {
    options.push(currentOptions);
    return host.showExtensionCustom(
      (tui, theme, bindings, done) =>
        factory(tui, theme, bindings, (value) => {
          doneCalls++;
          done(value);
        }),
      currentOptions,
    );
  };
  const context = createMockContext({ mode: "tui", hasUI: true, custom });
  return {
    ...context,
    host,
    mounted: mounted.promise,
    statuses,
    options,
    doneCalls: () => doneCalls,
    getText: () => text,
    setText: editor.setText,
  };
}

for (const kind of ["question", "permission", "auth"] as const) {
  test(`inline ${kind} status lasts only while the component is mounted`, async () => {
    const current = createInlineHost();
    const blocked = { kind, message: "Consumer-owned prompt" };
    let complete!: (value: string) => void;
    let disposed = 0;
    const running = runCustomInteraction(current.ctx, {
      blocked,
      create: (context) => {
        complete = context.complete;
        return { render: () => ["Answer"], invalidate() {}, dispose: () => disposed++ };
      },
    });
    await current.mounted;
    const visibleStatus = current.statuses.at(-1);
    complete("answer");
    const result = await running;
    assert.deepEqual(result, { kind: "completed", value: "answer" });
    assert.deepEqual(current.options, [{ blocked }]);
    assert.deepEqual(visibleStatus, blocked);
    assert.deepEqual(current.statuses, [blocked, undefined]);
    assert.equal(disposed, 1);
    assert.equal(current.host.extensionDialogs.length, 0);
  });
}

for (const reason of ["User cancelled", "Session replaced", "Runtime reloaded", "Session shutdown"] as const) {
  test(`${reason} clears inline status before pending work drains`, async () => {
    const current = createInlineHost();
    const owner = new AbortController();
    const pending = deferred<void>();
    let interactionSignal: AbortSignal | undefined;
    let disposed = 0;
    const running = runCustomInteraction(current.ctx, {
      blocked: { kind: "question", message: "Answer" },
      signal: owner.signal,
      create: ({ signal }) => {
        interactionSignal = signal;
        return {
          render: () => ["Answer"],
          invalidate() {},
          waitForPending: () => pending.promise,
          dispose: () => disposed++,
        };
      },
    });
    await current.mounted;
    owner.abort(new DOMException(reason, "AbortError"));
    const statusAfterAbort = current.statuses.at(-1);
    const workAborted = interactionSignal?.aborted;
    pending.resolve();
    assert.deepEqual(await running, { kind: "stale" });
    assert.equal(statusAfterAbort, undefined);
    assert.equal(workAborted, true);
    assert.equal(disposed, 1);
    assert.equal(current.host.extensionDialogs.length, 0);
  });
}

for (const boundary of ["replacement", "reload", "shutdown", "early owner-abort reset"] as const) {
  test(`host-only ${boundary} disposal settles without changing its reset iteration or new draft`, async () => {
    const current = createInlineHost();
    const owner = new AbortController();
    if (boundary === "early owner-abort reset") {
      // A host listener can reset inline UI before Kit receives the same abort.
      owner.signal.addEventListener("abort", () => current.host.resetExtensionUI(), { once: true });
    }
    const pending = deferred<void>();
    let complete!: (value: string) => void;
    let disposed = 0;
    let aborted = false;
    const running = runCustomInteraction(current.ctx, {
      blocked: { kind: "question", message: "Old prompt" },
      signal: owner.signal,
      create: (context) => {
        complete = context.complete;
        context.signal.addEventListener("abort", () => {
          aborted = true;
          complete("from abort");
        });
        return {
          render: () => ["Old prompt"],
          invalidate() {},
          waitForPending: () => pending.promise,
          dispose() {
            disposed++;
            complete("from dispose");
            throw new Error("Disposal failed during host teardown");
          },
        };
      },
    });
    await current.mounted;
    let siblingDisposed = 0;
    current.host.extensionDialogs.push({
      component: { render: () => [], invalidate() {}, dispose: () => siblingDisposed++ },
    });
    if (boundary === "early owner-abort reset") owner.abort();
    else current.host.resetExtensionUI();
    current.setText("replacement draft");
    complete("late completion");
    pending.resolve();
    const result = await running;
    // A second reset and late callback must remain harmless.
    current.host.resetExtensionUI();
    complete("later completion");
    assert.deepEqual(result, { kind: "stale" });
    assert.equal(current.statuses.at(-1), undefined);
    assert.equal(aborted, true);
    assert.equal(disposed, 1);
    assert.equal(siblingDisposed, 1);
    assert.equal(current.doneCalls(), 0);
    assert.deepEqual(current.notifications, []);
    assert.equal(current.getText(), "replacement draft");
    assert.equal(current.host.extensionDialogs.length, 0);
  });
}

for (const failure of ["synchronous", "asynchronous"] as const) {
  test(`${failure} initialization failure never publishes blocked status`, async () => {
    const current = createInlineHost();
    const error = new Error("Initialization failed");
    let signal: AbortSignal | undefined;
    const result = await runCustomInteraction(current.ctx, {
      blocked: { kind: "question", message: "Never visible" },
      create: (context) => {
        signal = context.signal;
        if (failure === "synchronous") throw error;
        return Promise.reject(error);
      },
      onError: () => {},
    });
    assert.deepEqual(result, { kind: "error", error });
    assert.equal(signal?.aborted, true);
    assert.deepEqual(current.options, [{ blocked: { kind: "question", message: "Never visible" } }]);
    assert.deepEqual(current.statuses, []);
    assert.equal(current.host.extensionDialogs.length, 0);
  });
}

test("shutdown during async creation prevents late mounting and drains the late component", async () => {
  const current = createInlineHost();
  const owner = new AbortController();
  const started = deferred<void>();
  const creation = deferred<void>();
  let disposed = 0;
  let drained = 0;
  const running = runCustomInteraction(current.ctx, {
    blocked: { kind: "question", message: "Never mounted" },
    signal: owner.signal,
    create: async () => {
      started.resolve();
      await creation.promise;
      return {
        render: () => [],
        invalidate() {},
        dispose: () => disposed++,
        waitForPending: async () => {
          drained++;
        },
      };
    },
  });
  await started.promise;
  owner.abort();
  current.host.resetExtensionUI();
  creation.resolve();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(disposed, 1);
  assert.equal(drained, 1);
  assert.deepEqual(current.statuses, []);
  assert.equal(current.host.extensionDialogs.length, 0);
});

test("questionnaire forwards consumer status only to TUI", async () => {
  const harness = createTuiHarness();
  const captured: CustomOptions[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: ((factory, options) => {
      captured.push(options);
      return harness.custom(factory, options);
    }) satisfies Custom,
  });
  const blocked = { kind: "question", message: "Choose a scope" } as const;
  const options = {
    blocked,
    questions: [{ id: "scope", header: "Scope", prompt: "How broad?", options: [{ label: "Small" }] }],
  };
  const running = runQuestionnaire(context.ctx, options);
  await harness.waitForOpen();
  harness.press("tui.select.confirm");
  const result = await running;
  assert.equal(result.kind, "submitted");
  assert.deepEqual(captured, [{ blocked }]);

  const rpc = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => "1. Small",
    custom: () => {
      throw new Error("RPC must not open custom UI");
    },
  });
  assert.equal((await runQuestionnaire(rpc.ctx, options)).kind, "submitted");
  for (const mode of ["print", "json"] as const) {
    const headless = createMockContext({ mode, hasUI: false });
    assert.deepEqual(await runQuestionnaire(headless.ctx, options), { kind: "unsupported", mode });
  }
});

test("unmarked interactions and task loaders do not declare blocked status", async () => {
  const current = createInlineHost();
  const task = deferred<string>();
  const running = runTask(current.ctx, { label: "Generating", task: () => task.promise });
  await current.mounted;
  const workingStatuses = [...current.statuses];
  task.resolve("generated");
  assert.deepEqual(await running, { kind: "completed", value: "generated" });
  const interaction = await runCustomInteraction(current.ctx, {
    create: ({ complete }) => {
      complete("unmarked");
      return { render: () => [], invalidate() {} };
    },
  });
  assert.deepEqual(interaction, { kind: "completed", value: "unmarked" });
  assert.deepEqual(current.options, [undefined, undefined]);
  assert.ok(workingStatuses.every((status) => status === undefined));
  assert.ok(current.statuses.every((status) => status === undefined));
});
