import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

test("settings local-field input is disposed with owned cancellation and no save", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const before = JSON.stringify(v3S3Settings());
    await fs.writeFile(localConfigPath(), before);
    const controller = new AbortController();
    let reportStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    let inputCancelled = false;
    let receivedSignal = false;
    const context = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 100);
        harness.handleInput("Machine-local");
        harness.handleInput("\r");
        await started;
        controller.abort(new DOMException("Session replaced", "AbortError"));
        harness.dispose();
        return harness.result;
      },
    });
    (context.ctx as ExtensionCommandContext).ui.input = async (_title, _placeholder, options) => {
      receivedSignal = Boolean(options?.signal);
      reportStarted();
      return new Promise((resolve) =>
        options?.signal?.addEventListener(
          "abort",
          () => {
            inputCancelled = true;
            resolve(undefined);
          },
          { once: true },
        ),
      );
    };
    await showSyncSettings(context.ctx, async () => undefined, controller.signal);
    assert.equal(receivedSignal, true);
    assert.equal(inputCancelled, true);
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
  }));

for (const confirmed of [false, true]) {
  test(`empty policy input is explicit opt-in and requires confirmation: ${confirmed}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const before = JSON.stringify(v3S3Settings());
      await fs.writeFile(localConfigPath(), before);
      let confirmations = 0;
      let activated = false;
      let seenPolicy: string[] | undefined;
      const context = createMockContext({
        hasUI: true,
        mode: "tui",
        custom: async (factory: unknown) => {
          const harness = createCustomSelectorHarness(factory, 100);
          if (activated) {
            harness.handleInput("tui.select.cancel");
            await harness.waitForPending();
            harness.dispose();
            return harness.result;
          }
          activated = true;
          harness.handleInput("Machine-local");
          harness.handleInput("\r");
          await harness.waitForPending();
          seenPolicy = (await loadConfig()).localFields;
          harness.handleInput("tui.select.cancel");
          await harness.waitForPending();
          harness.dispose();
          return harness.result;
        },
      });
      (context.ctx as ExtensionCommandContext).ui.input = async () => "[]";
      (context.ctx as ExtensionCommandContext).ui.confirm = async () => {
        confirmations++;
        return confirmed;
      };
      await showSyncSettings(context.ctx, async () => undefined);
      assert.equal(confirmations, 1);
      assert.deepEqual(seenPolicy, confirmed ? [] : undefined);
      if (confirmed) assert.equal(JSON.parse(await fs.readFile(localConfigPath(), "utf8")).version, 4);
      else assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
    }));
}

test("settings policy controls are read-only in RPC and do not open custom UI", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const before = JSON.stringify(v3S3Settings());
    await fs.writeFile(localConfigPath(), before);
    let custom = false;
    const context = createMockContext({
      hasUI: true,
      mode: "rpc",
      custom: async () => {
        custom = true;
      },
    });
    await showSyncSettings(context.ctx, async () => undefined);
    assert.equal(custom, false);
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
    assert.ok(context.notifications.length > 0);
  }));
