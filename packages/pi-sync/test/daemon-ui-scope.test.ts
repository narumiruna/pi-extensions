import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { bindPiDaemonClient, currentPiDaemonClient, withPiDaemonClient } from "../src/daemon/pi-client.js";
import { withTempHome } from "./helpers.js";

function fixture() {
  let component!: Component & { focused?: boolean; dispose?(): void };
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ctx = {
    sessionManager: {},
    isIdle: () => true,
    ui: {
      custom: async (factory: (...args: unknown[]) => Component | Promise<Component>) => {
        component = await factory({}, {}, {}, () => finish());
        entered();
        await completed;
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    ready,
    get component() {
      return component;
    },
  };
}

test("Pi event-loop component calls retain exact session scope, receiver, focus, and pasted input", () =>
  withTempHome(async () => {
    const testUi = fixture();
    const abort = new AbortController();
    const client = bindPiDaemonClient(testUi.ctx, abort.signal);
    const owners: string[] = [];
    const inputs: string[] = [];
    let disposed = false;
    const flow = withPiDaemonClient(testUi.ctx, async (ctx) =>
      ctx.ui.custom((_tui, _theme, _keys, done) => {
        class View implements Component {
          #text = "read-only preview";
          focused = false;
          invalidate() {}
          render() {
            return [this.#text];
          }
          handleInput(data: string) {
            owners.push(currentPiDaemonClient().id);
            inputs.push(data);
            if (data === "alt-enter") done(undefined);
          }
          dispose() {
            disposed = true;
          }
        }
        return new View();
      }),
    );
    try {
      await testUi.ready;
      assert.throws(() => currentPiDaemonClient(), /session-bound/u);
      testUi.component.focused = true;
      assert.equal(testUi.component.focused, true);
      assert.deepEqual(testUi.component.render(80), ["read-only preview"]);
      const paste = "\u001b[200~line one\nline two\u001b[201~";
      testUi.component.handleInput?.(paste);
      testUi.component.handleInput?.("alt-enter");
      await flow;
      assert.deepEqual(owners, [client.id, client.id]);
      assert.deepEqual(inputs, [paste, "alt-enter"]);
      testUi.component.dispose?.();
      assert.equal(disposed, true);
    } finally {
      abort.abort();
      await client.dispose();
    }
  }));

test("a stale component cannot switch its settings authority to a replacement session", () =>
  withTempHome(async () => {
    const testUi = fixture();
    const abort = new AbortController();
    const old = bindPiDaemonClient(testUi.ctx, abort.signal);
    let done!: () => void;
    const flow = withPiDaemonClient(testUi.ctx, async (ctx) =>
      ctx.ui.custom((_tui, _theme, _keys, finish) => {
        done = () => finish(undefined);
        return {
          render: () => ["review"],
          invalidate() {},
          handleInput: () => {
            currentPiDaemonClient();
          },
        };
      }),
    );
    await testUi.ready;
    abort.abort(new DOMException("Session replaced", "AbortError"));
    const replacement = bindPiDaemonClient(testUi.ctx, new AbortController().signal);
    try {
      assert.throws(
        () => testUi.component.handleInput?.("enter"),
        (error) => error instanceof Error && error.name === "AbortError",
      );
    } finally {
      done();
      await flow;
      await old.dispose();
      await replacement.dispose();
    }
  }));
