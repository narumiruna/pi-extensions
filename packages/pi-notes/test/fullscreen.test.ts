import assert from "node:assert/strict";
import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type NotesFullscreenTuiFactory, runFullscreenInteraction } from "../src/fullscreen.js";

class MouseTerminal implements Terminal {
  readonly columns = 100;
  readonly rows = 30;
  readonly kittyProtocolActive = false;
  private input: ((data: string) => void) | undefined;
  private output = "";

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }

  stop(): void {
    this.input = undefined;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  send(data: string): void {
    this.input?.(data);
  }

  hasOutput(text: string): boolean {
    return this.output.includes(text);
  }
}

interface HarnessOptions {
  drainError?: Error;
  createTuiError?: Error;
  customErrorAfterFactory?: Error;
  abortBeforeFactory?: AbortController;
}

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  let outerComponent: (Component & { dispose?(): void }) | undefined;
  let fullscreenComponent: Component | undefined;
  const terminal = {
    columns: 100,
    rows: 30,
    async drainInput() {
      events.push("terminal.drain");
      if (options.drainError) throw options.drainError;
    },
  };
  const parent = {
    mode: "regular",
    terminal,
    getShowHardwareCursor: () => false,
    stop(stopOptions?: { preserveScreen?: boolean }) {
      events.push(`parent.stop:${String(stopOptions?.preserveScreen)}`);
    },
    start() {
      events.push("parent.start");
    },
    renderNow(force?: boolean) {
      events.push(`parent.render:${String(force)}`);
    },
  } as unknown as TUI;
  const fullscreen = {
    mode: "fullscreen",
    terminal,
    start() {
      events.push("fullscreen.start");
    },
    stop(stopOptions?: { preserveScreen?: boolean }) {
      events.push(`fullscreen.stop:${String(stopOptions?.preserveScreen)}`);
    },
    setLayoutRoot(component: Component | undefined) {
      fullscreenComponent = component;
      events.push(component ? "fullscreen.layout" : "fullscreen.layout.clear");
    },
    setFocus(component: Component | null) {
      events.push(component ? "fullscreen.focus" : "fullscreen.unfocus");
    },
    requestRender() {
      events.push("fullscreen.render");
    },
  };
  const createTui: NotesFullscreenTuiFactory = () => {
    if (options.createTuiError) throw options.createTuiError;
    return fullscreen as never;
  };
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const theme = {
    fg: (_role: string, text: string) => text,
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async <Value>(
        factory: (
          parent: TUI,
          theme: unknown,
          keybindings: KeybindingsManager,
          done: (value: Value) => void,
        ) => Component | Promise<Component>,
        customOptions?: {
          overlay?: boolean;
          onHandle?(handle: { setHidden(hidden: boolean): void }): void;
        },
      ) => {
        assert.equal(customOptions?.overlay, true);
        let resolveResult!: (value: Value) => void;
        const result = new Promise<Value>((resolve) => {
          resolveResult = resolve;
        });
        options.abortBeforeFactory?.abort(new DOMException("session replaced", "AbortError"));
        outerComponent = (await factory(parent, theme, keybindings, resolveResult)) as Component & {
          dispose?(): void;
        };
        customOptions?.onHandle?.({
          setHidden(hidden) {
            events.push(`overlay.hidden:${String(hidden)}`);
          },
        });
        if (options.customErrorAfterFactory) throw options.customErrorAfterFactory;
        const value = await result;
        outerComponent.dispose?.();
        return value;
      },
    },
  } as never;
  return {
    ctx,
    createTui,
    events,
    get fullscreenComponent() {
      return fullscreenComponent;
    },
    disposeOuter() {
      outerComponent?.dispose?.();
    },
  };
}

async function waitForEvent(events: string[], expected: string): Promise<void> {
  for (let turn = 0; turn < 50 && !events.includes(expected); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(events.includes(expected), `missing event: ${expected}`);
}

test("fullscreen interaction owns the terminal, waits for cleanup, and restores the parent", async () => {
  const harness = createHarness();
  let complete!: (value: string) => void;
  const running = runFullscreenInteraction(
    harness.ctx,
    {
      create: ({ complete: finish }) => {
        complete = finish;
        return {
          render: () => ["workspace"],
          invalidate() {},
          dispose() {
            harness.events.push("component.dispose");
          },
          async waitForPending() {
            harness.events.push("component.pending");
          },
        };
      },
    },
    { createTui: harness.createTui },
  );

  await waitForEvent(harness.events, "fullscreen.layout");
  assert.deepEqual(harness.events.slice(0, 5), [
    "parent.stop:true",
    "fullscreen.start",
    "fullscreen.layout",
    "fullscreen.focus",
    "fullscreen.render",
  ]);
  complete("closed");

  assert.deepEqual(await running, { kind: "completed", value: "closed" });
  assert.deepEqual(harness.events.slice(5), [
    "component.dispose",
    "component.pending",
    "fullscreen.unfocus",
    "fullscreen.layout.clear",
    "terminal.drain",
    "fullscreen.stop:true",
    "overlay.hidden:true",
    "parent.start",
    "parent.render:false",
  ]);
});

test("native fullscreen routes terminal wheel input to the workspace", async () => {
  const terminal = new MouseTerminal();
  const parent = {
    mode: "regular",
    terminal,
    getShowHardwareCursor: () => false,
    stop: () => terminal.stop(),
    start: () => terminal.start(() => undefined),
    renderNow() {},
  } as unknown as TUI;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  let complete!: (value: string) => void;
  let receivedWheel: number | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async <Value>(
        factory: (
          parent: TUI,
          theme: unknown,
          keybindings: KeybindingsManager,
          done: (value: Value) => void,
        ) => Component | Promise<Component>,
        customOptions?: { overlay?: boolean; onHandle?(handle: { setHidden(hidden: boolean): void }): void },
      ) => {
        let resolveResult!: (value: Value) => void;
        const result = new Promise<Value>((resolve) => {
          resolveResult = resolve;
        });
        const component = await factory(
          parent,
          { fg: (_role: string, text: string) => text },
          keybindings,
          resolveResult,
        );
        customOptions?.onHandle?.({ setHidden() {} });
        const value = await result;
        (component as Component & { dispose?(): void }).dispose?.();
        return value;
      },
    },
  } as never;
  terminal.start(() => undefined);
  const running = runFullscreenInteraction(ctx, {
    create: ({ complete: finish }) => {
      complete = finish;
      return {
        render: () => ["workspace"],
        invalidate() {},
        handleMouse(event) {
          if (event.type === "wheel") receivedWheel = event.wheelDelta;
          return { handled: true };
        },
      };
    },
  });

  for (let turn = 0; turn < 50 && !terminal.hasOutput("workspace"); turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(complete);
  assert.equal(terminal.hasOutput("workspace"), true, "fullscreen layout rendered before input");
  terminal.send("\u001b[<64;3;4M");
  assert.equal(receivedWheel, -1);
  complete("closed");
  assert.deepEqual(await running, { kind: "completed", value: "closed" });
});

test("cancellation between preflight and host creation finishes stale without taking the terminal", async () => {
  const controller = new AbortController();
  const harness = createHarness({ abortBeforeFactory: controller });
  let componentCreated = false;

  const result = await runFullscreenInteraction(
    harness.ctx,
    {
      signal: controller.signal,
      create: () => {
        componentCreated = true;
        return { render: () => ["workspace"], invalidate() {} };
      },
    },
    { createTui: harness.createTui },
  );

  assert.deepEqual(result, { kind: "stale" });
  assert.equal(componentCreated, false);
  assert.equal(harness.events.includes("parent.stop:true"), false);
});

test("upstream cancellation disposes fullscreen work and returns stale after restoration", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const running = runFullscreenInteraction(
    harness.ctx,
    {
      signal: controller.signal,
      create: () => ({
        render: () => ["workspace"],
        invalidate() {},
        dispose() {
          harness.events.push("component.dispose");
        },
      }),
    },
    { createTui: harness.createTui },
  );

  await waitForEvent(harness.events, "fullscreen.layout");
  controller.abort(new DOMException("session replaced", "AbortError"));

  assert.deepEqual(await running, { kind: "stale" });
  assert.ok(harness.events.includes("component.dispose"));
  assert.ok(harness.events.includes("fullscreen.stop:true"));
  assert.ok(harness.events.includes("parent.start"));
});

test("outer custom UI failure disposes fullscreen work before returning the error", async () => {
  const customError = new Error("parent custom UI failed");
  const harness = createHarness({ customErrorAfterFactory: customError });
  const reported: unknown[] = [];

  const result = await runFullscreenInteraction(
    harness.ctx,
    {
      create: () => ({ render: () => ["workspace"], invalidate() {} }),
      onError: (_ctx, error) => {
        reported.push(error);
      },
    },
    { createTui: harness.createTui },
  );

  assert.deepEqual(result, { kind: "error", error: customError });
  assert.deepEqual(reported, [customError]);
  assert.ok(harness.events.includes("fullscreen.stop:true"));
  assert.ok(harness.events.includes("parent.start"));
});

test("fullscreen startup failure restores the parent and reports the original error", async () => {
  const startupError = new Error("fullscreen unavailable");
  const harness = createHarness({ createTuiError: startupError });
  const reported: unknown[] = [];

  const result = await runFullscreenInteraction(
    harness.ctx,
    {
      create: () => ({ render: () => ["workspace"], invalidate() {} }),
      onError: (_ctx, error) => {
        reported.push(error);
      },
    },
    { createTui: harness.createTui },
  );

  assert.deepEqual(result, { kind: "error", error: startupError });
  assert.deepEqual(reported, [startupError]);
  assert.equal(harness.events.includes("fullscreen.start"), false);
  assert.ok(harness.events.includes("parent.start"));
});

test("fullscreen cleanup continues after input drain fails and reports the error", async () => {
  const drainError = new Error("input drain failed");
  const harness = createHarness({ drainError });
  let complete!: (value: string) => void;
  const reported: unknown[] = [];
  const running = runFullscreenInteraction(
    harness.ctx,
    {
      create: ({ complete: finish }) => {
        complete = finish;
        return { render: () => ["workspace"], invalidate() {} };
      },
      onError: (_ctx, error) => {
        reported.push(error);
      },
    },
    { createTui: harness.createTui },
  );

  await waitForEvent(harness.events, "fullscreen.layout");
  complete("closed");

  assert.deepEqual(await running, { kind: "error", error: drainError });
  assert.deepEqual(reported, [drainError]);
  assert.ok(harness.events.includes("fullscreen.stop:true"));
  assert.ok(harness.events.includes("parent.start"));
});
