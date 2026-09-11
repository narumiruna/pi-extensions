import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { showAccountsMenu } from "../src/account-menu.js";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import { createBuiltinProviderAdapters } from "../src/oauth.js";

beforeAll(() => initTheme("dark", false));

const credential = {
  type: "oauth" as const,
  access: "secret-access",
  refresh: "secret-refresh",
  expires: 2_000_000_000_000,
};
const adapters = new Map(createBuiltinProviderAdapters().map((adapter) => [adapter.id, adapter]));
const handlers = {
  async login() {
    throw new Error("Unexpected login");
  },
  async switch() {
    throw new Error("Unexpected switch");
  },
  async remove() {
    throw new Error("Unexpected remove");
  },
};

async function setup() {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("anthropic", () => ({
    active: "alpha",
    accounts: { alpha: credential, beta: credential },
  }));
  const controller = new AbortController();
  const owner = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  return { store, controller, owner };
}

for (const cancelAt of [1, 2]) {
  test(`default picker cancellation at screen ${cancelAt} does not write settings`, async () => {
    const { store, owner } = await setup();
    const before = store.read();
    const choices = ["Set default account", "Anthropic"].slice(0, cancelAt);
    const { ctx } = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async () => choices.shift(),
    });
    await showAccountsMenu(ctx, store, adapters, { selections: { anthropic: "alpha" } }, handlers, owner);
    assert.deepEqual(store.read(), before);
  });
}

for (const failure of ["removed", "write", "shutdown"] as const) {
  test(`default picker revalidates ${failure} at the locked mutation boundary`, async () => {
    const { store, owner, controller } = await setup();
    const choices = ["Set default account", "Anthropic", "beta"];
    const update = store.updateProvider.bind(store);
    const { ctx, notifications } = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async () => {
        const choice = choices.shift();
        if (choice === "beta") {
          store.updateProvider = async (provider, mutator) => {
            if (failure === "write") throw new Error("secret-access");
            if (failure === "shutdown") controller.abort();
            if (failure === "removed")
              await update(provider, (state) => ({ ...state, accounts: { alpha: credential } }));
            return update(provider, mutator);
          };
        }
        return choice;
      },
    });
    await showAccountsMenu(ctx, store, adapters, { selections: { anthropic: "alpha" } }, handlers, owner);
    assert.equal(store.read().providers.anthropic?.active, "alpha");
    assert.equal(
      notifications.some((notice) => notice.message.includes("secret-access")),
      false,
    );
    assert.equal(
      notifications.some((notice) => notice.level === "error"),
      failure !== "shutdown",
    );
    // A failed action does not poison the next explicit save.
    store.updateProvider = update;
    await update("anthropic", (state) => ({ ...state, active: undefined }));
    assert.equal(store.read().providers.anthropic?.active, undefined);
  });
}

for (const finish of ["save", "cancel", "dispose", "shutdown"] as const) {
  test(`TUI default picker supports ${finish} with injected non-default keybindings`, async () => {
    const { store, owner, controller } = await setup();
    const renders: string[] = [];
    let screen = 0;
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const bindings: Record<string, string> = {
          "tui.select.down": "j",
          "tui.select.up": "k",
          "tui.select.confirm": "!",
          "tui.select.cancel": "q",
        };
        const harness = createCustomSelectorHarness(factory, 100, {
          matches: (data, key) => bindings[key] === data,
          getKeys: (key) => (bindings[key] ? [bindings[key]] : []),
        });
        try {
          renders.push(harness.render().join("\n"));
          if (screen === 0) {
            // Unsupported current model: login, switch, remove, set default.
            for (let i = 0; i < 3; i++) harness.handleInput("j");
          } else if (screen === 2) {
            if (finish === "cancel") harness.handleInput("\u0003");
            else if (finish === "dispose") {
              harness.dispose();
              return undefined;
            } else if (finish === "shutdown") controller.abort();
            else {
              // Pi login, disabled alpha, beta.
              harness.handleInput("j");
              harness.handleInput("j");
            }
          }
          screen++;
          if (harness.result === undefined) harness.handleInput("!");
          return await harness.resultPromise;
        } finally {
          harness.dispose();
        }
      },
    });
    await showAccountsMenu(ctx, store, adapters, { selections: { anthropic: "alpha" } }, handlers, owner);
    assert.equal(screen, finish === "dispose" ? 2 : 3);
    assert.match(renders[2] ?? "", /Default Anthropic account/);
    assert.match(renders[2] ?? "", /Saved default: alpha/);
    assert.equal(renders.join("\n").includes("secret-access"), false);
    assert.equal(store.read().providers.anthropic?.active, finish === "save" ? "beta" : "alpha");
    assert.equal(
      notifications.some((notice) => notice.level === "error"),
      false,
    );
  });
}
