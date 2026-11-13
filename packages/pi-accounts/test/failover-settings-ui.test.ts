import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeAll, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showAccountsMenu } from "../src/account-menu.js";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import { readFailoverSettings, saveFailoverSettings } from "../src/failover-settings.js";
import { showFailoverSettings } from "../src/failover-settings-ui.js";
import { createBuiltinProviderAdapters } from "../src/oauth.js";

beforeAll(() => initTheme("dark", false));
const originalBindings = getKeybindings();
afterEach(() => setKeybindings(originalBindings));
const credential = { type: "api_key" as const, key: "fixture-only-secret" };
const adapters = new Map(createBuiltinProviderAdapters().map((adapter) => [adapter.id, adapter]));
const handlers = { async login() {}, async switch() {}, async remove() {} };
const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(overrides: Parameters<typeof createTuiHarness>[0] = {}) {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("anthropic", () => ({
    active: "primary",
    accounts: { primary: credential, spare: credential, third: credential },
    future: "keep",
  }));
  await saveFailoverSettings(store, "anthropic", {
    enabled: false,
    accounts: ["spare", "third"],
    minRemainingPercent: 5,
  });
  const tui = createTuiHarness(overrides);
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom: tui.custom, notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  const controller = new AbortController();
  let current = true;
  const owner = { signal: controller.signal, isCurrent: () => current && !controller.signal.aborted };
  const applied: boolean[] = [];
  const changed = async () => {
    applied.push(readFailoverSettings(await store.readProviderAsync("anthropic")).settings.enabled);
  };
  const start = (onChanged = changed) => showFailoverSettings(ctx, store, "anthropic", "Anthropic", owner, onChanged);
  const settings = async () => readFailoverSettings(await store.readProviderAsync("anthropic")).settings;
  return {
    store,
    tui,
    notifications,
    ctx,
    controller,
    owner,
    applied,
    start,
    settings,
    stale: () => {
      current = false;
    },
  };
}

function pauseDurableSave(current: Awaited<ReturnType<typeof fixture>>) {
  const saved = deferred();
  const release = deferred();
  const update = current.store.updateProviderAsync.bind(current.store);
  let first = true;
  current.store.updateProviderAsync = async (...args) => {
    const state = await update(...args);
    if (first) {
      first = false;
      saved.resolve();
      await release.promise;
    }
    return state;
  };
  return { saved, release };
}

test("native rows save immediately in one screen; Enter, Space, threshold input and paste retain native behavior", async () => {
  const current = await fixture();
  const command = current.start();
  await current.tui.waitForOpen();
  const initial = plain(current.tui.render()).join("\n");
  current.tui.send("\r");
  await current.tui.waitForPending();
  assert.equal((await current.settings()).enabled, true);
  current.tui.send(" ");
  await current.tui.waitForPending();
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  current.tui.send("\u007f");
  current.tui.send("\u001b[200~7.5\u001b[201~");
  current.tui.send("\r");
  await current.tui.waitForPending();
  const selected = plain(current.tui.render()).find((line) => line.startsWith("→"));
  current.tui.press("tui.select.cancel");
  assert.equal(await command, "back");
  assert.equal(current.tui.openCount, 1);
  assert.match(initial, /Failover enabled\s+false/);
  assert.match(initial, /Minimum remaining \(%\)\s+5/);
  assert.match(initial, /spare → third/);
  assert.match(selected ?? "", /Minimum remaining \(%\)\s+7.5/);
  assert.deepEqual(await current.settings(), {
    enabled: false,
    accounts: ["spare", "third"],
    minRemainingPercent: 7.5,
  });
  assert.deepEqual(current.applied, [true, false, false]);
  assert.equal((await current.store.readProviderAsync("anthropic")).active, "primary");
});

test("ordered backup submenu adds, reorders, and removes only explicit saved names", async () => {
  const current = await fixture();
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  assert.match(plain(current.tui.render()).join("\n"), /1\. spare/);
  current.tui.send("\r"); // Manage spare.
  current.tui.press("tui.select.down");
  current.tui.send("\r"); // Move later.
  await current.tui.waitForPending();
  assert.deepEqual((await current.settings()).accounts, ["third", "spare"]);
  current.tui.render();
  current.tui.press("tui.select.down"); // Add backup (spare cursor retained).
  current.tui.send("\r");
  const candidates = plain(current.tui.render()).join("\n");
  current.tui.send("\r");
  await current.tui.waitForPending();
  assert.deepEqual((await current.settings()).accounts, ["third", "spare", "primary"]);
  current.tui.render();
  current.tui.press("tui.select.up");
  current.tui.send("\r");
  current.tui.send("\r");
  await current.tui.waitForPending();
  assert.deepEqual((await current.settings()).accounts, ["third", "spare"]);
  current.tui.press("tui.select.cancel");
  current.tui.press("ctrl+c");
  assert.equal(await command, "close");
  assert.match(candidates, /primary/);
  assert.equal(candidates.includes("fixture-only-secret"), false);
});

test("remapped native navigation, submit, and cancel work; Ctrl+C remains hard cancel", async () => {
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.confirm": "!",
    "tui.select.cancel": "q",
    "tui.input.submit": "ctrl+s",
  });
  setKeybindings(bindings);
  const current = await fixture({ keybindings: bindings });
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.send("j");
  current.tui.send("!");
  current.tui.send("\u007f");
  current.tui.send("20");
  current.tui.send("\u0013");
  await current.tui.waitForPending();
  assert.equal((await current.settings()).minRemainingPercent, 20);
  current.tui.send("j");
  current.tui.send("!");
  current.tui.send("q");
  const main = plain(current.tui.render()).join("\n");
  current.tui.send("\u0003");
  assert.equal(await command, "close");
  assert.match(main, /Anthropic Failover Settings/);
  assert.equal(main.includes("Enter/Space"), false);
  assert.equal(main.includes("Esc to cancel"), false);
});

test("frame dimensions, focused rows, theme and clipped mouse mapping remain bounded", async () => {
  const roles: string[] = [];
  const current = await fixture({
    theme: {
      fg: (role, text) => {
        roles.push(role);
        return text;
      },
      bold: (text) => text,
    },
  });
  const zeroWidth: string[] = [];
  const custom = current.ctx.ui.custom;
  current.ctx.ui.custom = (factory, options) =>
    custom(async (...args) => {
      const component = await factory(...args);
      zeroWidth.push(...component.render(0));
      return component;
    }, options);
  const command = current.start();
  await current.tui.waitForOpen();
  const normal = plain(current.tui.render());
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.down");
  for (const rows of [24, 9, 8, 7, 6, 5, 4]) {
    for (const width of [1, 3, 8, 20, 80]) {
      const frame = current.tui.resize({ rows, width });
      assert.ok(frame.length <= Math.max(1, rows - 3));
      assert.ok(frame.every((line) => visibleWidth(line) <= width));
      if (width === 80) assert.ok(plain(frame).some((line) => line.startsWith("→ Ordered backups")));
      if (width > 0 && rows >= 8) {
        assert.equal(plain(frame)[0], "─".repeat(width));
        assert.equal(plain(frame).at(-1), "─".repeat(width));
      }
    }
  }
  const clipped = plain(current.tui.resize({ rows: 8, width: 80 }));
  const row = clipped.findIndex((line) => line.startsWith("→"));
  current.tui.mouse({ type: "click", x: 3, y: row });
  const submenu = plain(current.tui.render()).join("\n");
  current.tui.invalidate();
  current.tui.resize({ rows: 24, width: 30 });
  current.tui.press("ctrl+c");
  assert.equal(await command, "close");
  assert.ok(zeroWidth.length > 0);
  assert.ok(zeroWidth.every((line) => visibleWidth(line) === 0));
  assert.equal(normal[0], "─".repeat(100));
  assert.equal(normal.at(-1), "─".repeat(100));
  assert.match(submenu, /Ordered backup accounts/);
  assert.ok(roles.includes("border"));
  assert.ok(roles.includes("accent"));
  assert.ok(roles.includes("muted"));
});

test("rapid save requests serialize and reload sees the last committed value", async () => {
  const current = await fixture();
  const started = deferred();
  const release = deferred();
  const update = current.store.updateProviderAsync.bind(current.store);
  let count = 0;
  current.store.updateProviderAsync = async (...args) => {
    count++;
    if (count === 1) {
      started.resolve();
      await release.promise;
    }
    return update(...args);
  };
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.send("\r");
  current.tui.send("\r");
  current.tui.send("\r");
  await started.promise;
  assert.equal(count, 1);
  assert.deepEqual(current.applied, []);
  release.resolve();
  await current.tui.waitForPending();
  current.tui.press("ctrl+c");
  await command;
  assert.deepEqual(current.applied, [true, false, true]);
  assert.equal((await current.settings()).enabled, true);
});

test.each(["save", "apply"] as const)(
  "%s failure restores displayed and effective values and leaves the queue usable",
  async (failure) => {
    const current = await fixture();
    let fail = true;
    const update = current.store.updateProviderAsync.bind(current.store);
    if (failure === "save")
      current.store.updateProviderAsync = async (...args) => {
        if (fail) {
          fail = false;
          throw new Error("fixture-only-secret\u001b]0;unsafe\u0007");
        }
        return update(...args);
      };
    const changed = async () => {
      if (failure === "apply" && fail) {
        fail = false;
        throw new Error("fixture-only-secret");
      }
      current.applied.push((await current.settings()).enabled);
    };
    const command = current.start(changed);
    await current.tui.waitForOpen();
    current.tui.send("\r");
    await current.tui.waitForPending();
    const failed = plain(current.tui.render()).join("\n");
    assert.equal((await current.settings()).enabled, false);
    assert.match(failed, /Failover enabled\s+false/);
    current.tui.send("\r");
    await current.tui.waitForPending();
    current.tui.press("ctrl+c");
    await command;
    assert.equal((await current.settings()).enabled, true);
    assert.ok(current.notifications.some((message) => message.includes("Could not save")));
    assert.equal(current.notifications.join("\n").includes("fixture-only-secret"), false);
    assert.equal(current.notifications.join("\n").includes("\u001b"), false);
  },
);

test.each(["cancel", "dispose", "shutdown", "replace"] as const)(
  "%s cancels a pending save without stale application",
  async (finish) => {
    const current = await fixture();
    const started = deferred();
    const release = deferred();
    const update = current.store.updateProviderAsync.bind(current.store);
    let capturedSignal: AbortSignal | undefined;
    current.store.updateProviderAsync = async (id, mutator, signal) => {
      capturedSignal = signal;
      started.resolve();
      await release.promise;
      return update(id, mutator, signal);
    };
    const command = current.start();
    await current.tui.waitForOpen();
    current.tui.send("\r");
    await started.promise;
    if (finish === "cancel") current.tui.press("ctrl+c");
    else if (finish === "shutdown") current.controller.abort();
    else if (finish === "replace") {
      current.stale();
      current.tui.dispose();
    } else current.tui.dispose();
    assert.equal(capturedSignal?.aborted, true);
    release.resolve();
    await command;
    assert.equal((await current.settings()).enabled, false);
    assert.deepEqual(current.applied, []);
    assert.deepEqual(current.notifications, []);
  },
);

test.each(["known-policy", "invalid-policy", "removed-reference"] as const)(
  "runtime apply failure never overwrites a concurrent %s change",
  async (conflict) => {
    const current = await fixture();
    const changed = async () => {
      await current.store.updateProvider("anthropic", (state) => {
        if (conflict === "known-policy")
          return {
            ...state,
            fallback: { enabled: false, accounts: ["primary"], minRemainingPercent: 30, future: "keep" },
          };
        if (conflict === "invalid-policy") return { ...state, fallback: { enabled: "invalid", future: "keep" } };
        return { ...state, accounts: { primary: credential, third: credential } };
      });
      throw new Error("fixture application failure");
    };
    const command = current.start(changed);
    await current.tui.waitForOpen();
    current.tui.send("\r");
    assert.equal(await command, "close");
    const state = await current.store.readProviderAsync("anthropic");
    if (conflict === "known-policy")
      assert.deepEqual(readFailoverSettings(state).settings, {
        enabled: false,
        accounts: ["primary"],
        minRemainingPercent: 30,
      });
    if (conflict === "invalid-policy") assert.equal((state.fallback as { enabled: unknown }).enabled, "invalid");
    if (conflict === "removed-reference") assert.equal(Object.hasOwn(state.accounts, "spare"), false);
    assert.match(current.notifications.at(-1) ?? "", /could not be restored/);
  },
);

test("a closed screen hands a durable save to the current session and drains runtime application", async () => {
  const current = await fixture();
  const saved = deferred();
  const release = deferred();
  const applying = deferred();
  const applied = deferred();
  const update = current.store.updateProviderAsync.bind(current.store);
  current.store.updateProviderAsync = async (...args) => {
    const state = await update(...args);
    saved.resolve();
    await release.promise;
    return state;
  };
  let finished = false;
  const command = current
    .start(async () => {
      applying.resolve();
      await applied.promise;
      current.applied.push((await current.settings()).enabled);
    })
    .then((value) => {
      finished = true;
      return value;
    });
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await saved.promise;
  current.tui.press("ctrl+c");
  const renderCount = current.tui.requestRenderCount;
  release.resolve();
  await applying.promise;
  assert.equal(finished, false);
  applied.resolve();
  await command;
  assert.equal(current.tui.requestRenderCount, renderCount);
  assert.equal((await current.settings()).enabled, true);
  assert.deepEqual(current.applied, [true]);
});

test.each([false, true])(
  "a durable disable failure after close restores enabled settings and reports (notifier throws: %s)",
  async (notifierThrows) => {
    const current = await fixture();
    await saveFailoverSettings(current.store, "anthropic", { ...(await current.settings()), enabled: true });
    const { saved, release } = pauseDurableSave(current);
    current.ctx.ui.notify = (message) => {
      current.notifications.push(message);
      if (notifierThrows) throw new Error("notifier disposed");
    };
    const command = current.start(async () => {
      const enabled = (await current.settings()).enabled;
      current.applied.push(enabled);
      if (!enabled) throw new Error("fixture-only-secret");
    });
    await current.tui.waitForOpen();
    current.tui.send("\r");
    await saved.promise;
    assert.equal((await current.settings()).enabled, false);
    current.tui.press("ctrl+c");
    const renders = current.tui.requestRenderCount;
    release.resolve();
    assert.equal(await command, "close");
    assert.equal((await current.settings()).enabled, true);
    assert.deepEqual(current.applied, [false, true]);
    assert.equal(current.notifications.length, 1);
    assert.match(current.notifications[0] ?? "", /Previous settings remain effective/);
    assert.equal(current.notifications.join("\n").includes(credential.key), false);
    assert.equal(current.tui.requestRenderCount, renders);
  },
);

test.each(["storage", "apply", "known-policy", "invalid-policy", "removed-reference"] as const)(
  "a closed durable disable reports restoration failure after %s without overwriting a conflict",
  async (failure) => {
    const current = await fixture();
    await saveFailoverSettings(current.store, "anthropic", { ...(await current.settings()), enabled: true });
    const update = current.store.updateProviderAsync.bind(current.store);
    let writes = 0;
    current.store.updateProviderAsync = async (...args) => {
      if (++writes === 2 && failure === "storage") throw new Error("fixture rollback failure");
      return update(...args);
    };
    const { saved, release } = pauseDurableSave(current);
    let applications = 0;
    const command = current.start(async () => {
      if (++applications === 1 && failure.endsWith("policy")) {
        await update("anthropic", async (state) => ({
          ...state,
          fallback:
            failure === "known-policy"
              ? { enabled: false, accounts: ["primary"], minRemainingPercent: 30, future: "keep" }
              : { enabled: "invalid", future: "keep" },
        }));
      } else if (failure === "removed-reference") {
        await update("anthropic", async (state) => ({
          ...state,
          accounts: { primary: credential, third: credential },
        }));
      }
      throw new Error("fixture-only-secret");
    });
    await current.tui.waitForOpen();
    current.tui.send("\r");
    await saved.promise;
    current.tui.press("ctrl+c");
    const renders = current.tui.requestRenderCount;
    release.resolve();
    assert.equal(await command, "close");
    const state = await current.store.readProviderAsync("anthropic");
    if (failure === "invalid-policy") assert.equal((state.fallback as { enabled: unknown }).enabled, "invalid");
    else assert.equal(readFailoverSettings(state).settings.enabled, failure === "apply");
    if (failure === "known-policy")
      assert.deepEqual(state.fallback, {
        enabled: false,
        accounts: ["primary"],
        minRemainingPercent: 30,
        future: "keep",
      });
    if (failure === "removed-reference") assert.equal(Object.hasOwn(state.accounts, "spare"), false);
    assert.equal(applications, failure === "apply" ? 2 : 1);
    assert.equal(current.notifications.length, 1);
    assert.match(current.notifications[0] ?? "", /could not be restored/);
    assert.equal(current.notifications.join("\n").includes(credential.key), false);
    assert.equal(current.tui.requestRenderCount, renders);
  },
);

test.each(
  (["apply", "restore", "restored", "reapply"] as const).flatMap((phase) =>
    (["shutdown", "replace"] as const).map((finish) => ({ phase, finish })),
  ),
)("closed recovery during $phase does not publish after session $finish", async ({ phase, finish }) => {
  const current = await fixture();
  await saveFailoverSettings(current.store, "anthropic", { ...(await current.settings()), enabled: true });
  const started = deferred();
  const release = deferred();
  const update = current.store.updateProviderAsync.bind(current.store);
  let writes = 0;
  current.store.updateProviderAsync = async (...args) => {
    const restoring = ++writes === 2;
    if (restoring && phase === "restore") {
      started.resolve();
      await release.promise;
    }
    const state = await update(...args);
    if (restoring && phase === "restored") {
      started.resolve();
      await release.promise;
    }
    return state;
  };
  let applications = 0;
  const command = current.start(async () => {
    applications++;
    if ((applications === 1 && phase === "apply") || (applications === 2 && phase === "reapply")) {
      started.resolve();
      await release.promise;
    }
    throw new Error("fixture application failure");
  });
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await started.promise;
  current.tui.press("ctrl+c");
  const renders = current.tui.requestRenderCount;
  if (finish === "shutdown") current.controller.abort();
  else current.stale();
  release.resolve();
  assert.equal(await command, "stale");
  assert.equal((await current.settings()).enabled, phase === "restored" || phase === "reapply");
  assert.equal(applications, phase === "reapply" ? 2 : 1);
  assert.deepEqual(current.notifications, []);
  assert.equal(current.tui.requestRenderCount, renders);
});

test.each(["shutdown", "replace"] as const)("a durable save does not publish into a %s session", async (finish) => {
  const current = await fixture();
  const saved = deferred();
  const release = deferred();
  const update = current.store.updateProviderAsync.bind(current.store);
  current.store.updateProviderAsync = async (...args) => {
    const state = await update(...args);
    saved.resolve();
    await release.promise;
    return state;
  };
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await saved.promise;
  if (finish === "shutdown") current.controller.abort();
  else {
    current.stale();
    current.tui.dispose();
  }
  release.resolve();
  await command;
  assert.equal((await current.settings()).enabled, true);
  assert.deepEqual(current.applied, []);
});

test("UI field updates use the policy current at the locked mutation, including concurrent manual edits", async () => {
  const current = await fixture();
  const update = current.store.updateProviderAsync.bind(current.store);
  let first = true;
  current.store.updateProviderAsync = async (...args) => {
    if (first) {
      first = false;
      await update("anthropic", async (state) => ({
        ...state,
        fallback: { enabled: false, accounts: ["primary"], minRemainingPercent: 25, future: "keep" },
      }));
    }
    return update(...args);
  };
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await current.tui.waitForPending();
  const frame = plain(current.tui.render()).join("\n");
  current.tui.press("ctrl+c");
  await command;
  assert.deepEqual(await current.settings(), { enabled: true, accounts: ["primary"], minRemainingPercent: 25 });
  assert.match(frame, /Minimum remaining \(%\)\s+25/);
  assert.equal(((await current.store.readProviderAsync("anthropic")).fallback as { future: string }).future, "keep");
});

test("invalid threshold retains its draft, native cancellation leaves settings unchanged, and focus follows Input", async () => {
  const current = await fixture();
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.setFocused(true);
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  current.tui.send("\u007f");
  current.tui.send("100");
  current.tui.send("\r");
  const invalid = plain(current.tui.render()).join("\n");
  assert.match(invalid, /Enter a finite number/);
  assert.equal(current.tui.isFocusable, true);
  assert.equal(current.tui.focused, true);
  current.tui.press("tui.select.cancel");
  assert.match(plain(current.tui.render()).join("\n"), /Minimum remaining \(%\)\s+5/);
  current.tui.press("ctrl+c");
  await command;
  assert.equal((await current.settings()).minRemainingPercent, 5);
});

test("embedded Input owns split paste contents, including cancel and hard-cancel bytes", async () => {
  const current = await fixture();
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  current.tui.send("\u001b[200~");
  current.tui.send("\u0003");
  current.tui.send("\u001b");
  assert.equal(current.tui.isOpen, true);
  current.tui.send("\u001b[20");
  current.tui.send("1~");
  current.tui.send("\u0003");
  assert.equal(await command, "close");
  assert.equal((await current.settings()).minRemainingPercent, 5);
});

test("enabling without backups rolls back the row and does not apply runtime changes", async () => {
  const current = await fixture();
  await saveFailoverSettings(current.store, "anthropic", { enabled: false, accounts: [], minRemainingPercent: 5 });
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await current.tui.waitForPending();
  const frame = plain(current.tui.render()).join("\n");
  current.tui.press("ctrl+c");
  await command;
  assert.match(frame, /Failover enabled\s+false/);
  assert.deepEqual(current.applied, []);
  assert.equal((await current.settings()).enabled, false);
  assert.match(current.notifications[0] ?? "", /Could not save/);
});

test("a failing notifier cannot poison the next save", async () => {
  const current = await fixture();
  const update = current.store.updateProviderAsync.bind(current.store);
  let first = true;
  current.store.updateProviderAsync = async (...args) => {
    if (first) {
      first = false;
      throw new Error("fixture failure");
    }
    return update(...args);
  };
  current.ctx.ui.notify = () => {
    throw new Error("notifier disposed");
  };
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await current.tui.waitForPending();
  current.tui.send("\r");
  await current.tui.waitForPending();
  current.tui.press("ctrl+c");
  await command;
  assert.equal((await current.settings()).enabled, true);
});

test("removing the last enabled backup disables failover", async () => {
  const current = await fixture();
  await saveFailoverSettings(current.store, "anthropic", {
    enabled: true,
    accounts: ["spare"],
    minRemainingPercent: 5,
  });
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  current.tui.send("\r");
  current.tui.send("\r");
  await current.tui.waitForPending();
  current.tui.press("ctrl+c");
  await command;
  assert.deepEqual(await current.settings(), { enabled: false, accounts: [], minRemainingPercent: 5 });
});

test.each(["disable", "keep-enabled"] as const)(
  "two deleted backups permit %s and sequential removal in the native UI",
  async (mode) => {
    const current = await fixture();
    await saveFailoverSettings(current.store, "anthropic", { ...(await current.settings()), enabled: true });
    await current.store.updateProvider("anthropic", (state) => ({ ...state, accounts: { primary: credential } }));
    const command = current.start();
    await current.tui.waitForOpen();
    if (mode === "disable") {
      current.tui.send("\r");
      await current.tui.waitForPending();
      assert.equal((await current.settings()).enabled, false);
      assert.deepEqual((await current.settings()).accounts, ["spare", "third"]);
    }
    current.tui.press("tui.select.down");
    current.tui.press("tui.select.down");
    current.tui.send("\r");
    current.tui.send("\r");
    current.tui.send("\r");
    await current.tui.waitForPending();
    assert.deepEqual((await current.settings()).accounts, ["third"]);
    assert.equal((await current.settings()).enabled, mode === "keep-enabled");
    assert.match(plain(current.tui.render()).join("\n"), /1\. third/);
    current.tui.send("\r");
    current.tui.send("\r");
    await current.tui.waitForPending();
    current.tui.press("ctrl+c");
    assert.equal(await command, "close");
    assert.deepEqual(await current.settings(), { enabled: false, accounts: [], minRemainingPercent: 5 });
    assert.deepEqual(current.applied, mode === "disable" ? [false, false, false] : [true, false]);
    assert.deepEqual(current.notifications, []);
    assert.equal((await current.store.readProviderAsync("anthropic")).active, "primary");
  },
);

test("backup management and threshold input retain their focused rows at constrained dimensions", async () => {
  const current = await fixture();
  const command = current.start();
  await current.tui.waitForOpen();
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  current.tui.send("\r"); // Native action submenu.
  for (const rows of [24, 8, 7, 5, 4]) {
    for (const width of [1, 3, 20, 80]) {
      const frame = current.tui.resize({ rows, width });
      assert.ok(frame.length <= Math.max(1, rows - 3));
      assert.ok(frame.every((line) => visibleWidth(line) <= width));
      if (width === 80) assert.ok(plain(frame).some((line) => line.startsWith("→ Remove backup")));
    }
  }
  current.tui.press("tui.select.cancel");
  current.tui.press("tui.select.cancel");
  current.tui.press("tui.select.up");
  current.tui.send("\r");
  for (const rows of [24, 8, 5, 4]) {
    const frame = current.tui.resize({ rows, width: 40 });
    assert.ok(frame.length <= Math.max(1, rows - 3));
    assert.ok(frame.every((line) => visibleWidth(line) <= 40));
    assert.ok(plain(frame).some((line) => line.includes("5")));
  }
  current.tui.press("ctrl+c");
  await command;
});

test("TUI manager reaches native Settings and applies its callback without changing prior actions", async () => {
  const current = await fixture();
  const command = showAccountsMenu(
    current.ctx,
    current.store,
    adapters,
    { selections: { anthropic: "primary" } },
    handlers,
    current.owner,
    {
      changed: async () => {
        current.applied.push((await current.settings()).enabled);
      },
      status: () => "No switch recorded",
    },
  );
  await current.tui.waitForOpen();
  const main = plain(current.tui.render()).join("\n");
  for (let index = 0; index < 10 && !plain(current.tui.render()).some((line) => /^→ Settings/.test(line)); index++)
    current.tui.press("tui.select.down");
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  const settingsFrame = plain(current.tui.render()).join("\n");
  current.tui.send("\r");
  await current.tui.waitForPending();
  current.tui.press("ctrl+c");
  await command;
  assert.match(main, /Login new account/);
  assert.match(main, /Remove account/);
  assert.match(main, /Set default account/);
  assert.match(settingsFrame, /Anthropic Failover Settings/);
  assert.deepEqual(current.applied, [true]);
});

test.each(["Status", "Help"])("TUI %s uses a read-only detail screen with no cursor", async (action) => {
  const current = await fixture();
  const command = showAccountsMenu(
    current.ctx,
    current.store,
    adapters,
    { selections: { anthropic: "primary" } },
    handlers,
    current.owner,
  );
  await current.tui.waitForOpen();
  for (
    let index = 0;
    index < 10 && !plain(current.tui.render()).some((line) => line.startsWith(`→ ${action}`));
    index++
  )
    current.tui.press("tui.select.down");
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  const detail = plain(current.tui.render());
  current.tui.press("ctrl+c");
  await command;
  assert.ok(detail.some((line) => line.includes(action === "Status" ? "Account Status" : "Accounts Help")));
  assert.equal(
    detail.some((line) => line.startsWith("→")),
    false,
  );
});

test("invalid optional settings require manual repair and never mount custom UI", async () => {
  const current = await fixture();
  await current.store.updateProvider("anthropic", (state) => ({ ...state, fallback: { enabled: "invalid" } }));
  assert.equal(await current.start(), "back");
  assert.equal(current.tui.openCount, 0);
  assert.match(current.notifications[0] ?? "", /Repair providers.anthropic.fallback/);
  assert.equal((await current.store.readProviderAsync("anthropic")).accounts.primary?.key, credential.key);
});

test("RPC settings provide a manual path without custom TUI; Status and Help remain observable and secret-free", async () => {
  const current = await fixture();
  const choices = ["Settings", "Anthropic", undefined, "Status", "Back", "Help", "Back", undefined];
  const screens: string[] = [];
  let invocation = 0;
  const { ctx, notifications } = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, options: string[]) => {
      screens.push(`${title}\n${options.join("\n")}`);
      const choice = choices[invocation++];
      return choice;
    },
    custom: async () => {
      throw new Error("Unexpected TUI");
    },
  });
  const menuState = { changed: async () => {}, status: () => "Last switch: low allowance\u001b]0;unsafe\u0007" };
  await showAccountsMenu(
    ctx,
    current.store,
    adapters,
    { selections: { anthropic: "primary" }, environmentAccount: "primary" },
    handlers,
    current.owner,
    menuState,
  );
  // Reopen because Back from the provider picker returns to the main menu, while
  // an RPC cancel at the main menu closes that invocation.
  for (let index = 0; index < 2; index++) {
    await showAccountsMenu(
      ctx,
      current.store,
      adapters,
      { selections: { anthropic: "primary" }, environmentAccount: "primary" },
      handlers,
      current.owner,
      menuState,
    );
  }
  assert.ok(notifications.some((notice) => /pi-accounts.json.*run \/reload/.test(notice.message)));
  const output = screens.join("\n");
  assert.match(output, /Account Status/);
  assert.match(output, /Accounts Help/);
  assert.match(output, /PI_ACCOUNT/);
  assert.match(output, /spare → third/);
  assert.match(output, /Last switch: low allowance/);
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes(credential.key), false);
});

test.each(["print", "json"] as const)(
  "%s keeps the established manager rejection without opening UI or adding output",
  async (mode) => {
    const current = await fixture();
    const { ctx, notifications } = createMockContext({
      mode,
      hasUI: false,
      custom: async () => {
        throw new Error("Unexpected TUI");
      },
    });
    await showAccountsMenu(ctx, current.store, adapters, { selections: {} }, handlers, current.owner);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]?.message ?? "", /requires interactive UI/);
  },
);
