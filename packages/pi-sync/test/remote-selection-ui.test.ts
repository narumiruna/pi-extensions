import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { expectedRemoteHead } from "../src/backends/sync-backend.js";
import { loadConfig, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";
import { statePathForConfig } from "../src/state/sync-state-store.js";
import { showRemoteSelectionReview } from "../src/ui/remote-selection-ui.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

initTheme("dark", false);

test("remote selection difference is review-first, sanitized, and bounded", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["settings.json", "AGENTS.md"] })), {
      mode: 0o600,
    });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["pi-starship.toml", "settings.json"]);
    const rendered = new Map<number, string[]>();
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 60);
        for (const width of [32, 60, 100]) rendered.set(width, harness.render(width));
        assert.match(harness.render().join("\n"), /Review all paths \(recommended\)/u);
        harness.handleInput("tui.select.confirm");
        await harness.waitForPending();
        const review = harness.render().join("\n");
        assert.match(review, /Remote-only.*pi-starship\.toml/is);
        assert.match(review, /Device-only.*AGENTS\.md/is);
        assert.equal(review.includes("\u001b]8"), false);
        harness.handleInput("tui.select.cancel");
        harness.handleInput("tui.select.cancel");
        return harness.result;
      },
    });

    await showRemoteSelectionReview(ctx, "home", undefined, () => backend);

    for (const [width, lines] of rendered) {
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join("\n"), /Synced content differs/u);
    }
  });
});

test("captured setup text is sanitized at the review display boundary", async () => {
  const rendered = new Map<number, string[]>();
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "tui",
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 60);
      for (const width of [32, 60, 100]) rendered.set(width, harness.render(width));
      harness.handleInput("tui.select.cancel");
      return harness.result;
    },
  });

  await showRemoteSelectionReview(ctx, undefined, undefined, undefined, {
    decision: {
      setupName: "home\u001b]8;;spoof",
      configIdentity: "captured",
      localInclude: ["settings.json"],
      remoteInclude: ["models.json"],
    },
    origin: "sync",
  });

  for (const [width, lines] of rendered) {
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(lines.join("\n").includes("\u001b]8"), false);
  }
});

test("order-only selection difference is explicit in summary and exact review", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["settings.json", "AGENTS.md"] })), {
      mode: 0o600,
    });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["AGENTS.md", "settings.json"]);
    const tui = createTuiHarness({ width: 80, rows: 20 });
    const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend);

    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Only the ordering differs/u);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const reviewTop = tui.render().join("\n");
    tui.press("end");
    const reviewBottom = tui.render().join("\n");
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    tui.press("tui.select.cancel");
    await running;

    assert.match(reviewTop, /Only ordering differs/u);
    assert.match(reviewTop, /Remote ordered list:.*1\. AGENTS\.md/is);
    assert.match(reviewBottom, /This device's ordered list:.*1\. settings\.json/is);
  });
});

test("remote selection adoption saves settings only after session acknowledgement", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["settings.json", "pi-starship.toml", "sessions"]);
    let confirmations = 0;
    const tui = createTuiHarness({ width: 80, rows: 20 });
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: tui.custom,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    let routeCalls = 0;
    let resolutions = 0;
    let protectedActions = 0;
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend, {
      origin: "settings",
      runRoute: async () => {
        routeCalls += 1;
        return { kind: "completed" };
      },
      onSelectionResolved: () => {
        resolutions += 1;
      },
      withStateAccess: async (task) => {
        protectedActions += 1;
        return task();
      },
    });

    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Remote content list saved/u);
    assert.match(tui.render().join("\n"), /No files were pulled/u);
    assert.match(tui.render().join("\n"), /Continue Sync now/u);
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    assert.deepEqual(await running, { kind: "done" });

    assert.equal(confirmations, 1);
    assert.equal(routeCalls, 0);
    assert.equal(resolutions, 1);
    assert.equal(protectedActions, 1);
    assert.deepEqual((await readLocalConfigObject())?.syncSetups.home.sync.include, [
      "settings.json",
      "pi-starship.toml",
      "sessions",
    ]);
    assert.equal(existsSync(path.join(agentDir, "pi-starship.toml")), false);
    assert.equal(existsSync(statePathForConfig(await loadConfig())), false);
  });
});

test("refusing session acknowledgement keeps the comparison open and settings unchanged", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["settings.json", "sessions"]);
    const tui = createTuiHarness({ width: 80, rows: 20 });
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: tui.custom,
      confirm: async () => false,
    });
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend);

    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Synced content differs/u);
    tui.press("tui.select.cancel");
    assert.deepEqual(await running, { kind: "back" });
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("saved remote list can continue the captured route or stop without file mutation", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["settings.json", "pi-starship.toml"]);
    const tui = createTuiHarness({ width: 80, rows: 20 });
    const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
    const routes: Array<{ route: string; target?: string }> = [];
    let releaseRoute: () => void = () => undefined;
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend, {
      origin: "pull",
      runRoute: async (route, _signal, _onCommit, target) => {
        routes.push({ route, target });
        await routeGate;
        return { kind: "completed", outcome: "applied" };
      },
    });

    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Continue Pull now/u);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.deepEqual(routes, [{ route: "pull", target: "home" }]);
    assert.equal(existsSync(path.join(agentDir, "pi-starship.toml")), false);
    releaseRoute();
    assert.deepEqual(await running, {
      kind: "route-result",
      result: { kind: "completed", outcome: "applied" },
      route: "pull",
    });
  });
});

test("keeping this device list invokes reviewed push force and cancellation returns", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const tui = createTuiHarness({ width: 80, rows: 20 });
    const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
    const routes: Array<{ route: string; target?: string }> = [];
    let releaseRoute: () => void = () => undefined;
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    const config = await loadConfig("home");
    const running = showRemoteSelectionReview(ctx, "home", undefined, undefined, {
      decision: {
        setupName: "home",
        configIdentity: syncConfigReviewFingerprint(config),
        localInclude: ["settings.json"],
        remoteInclude: ["settings.json", "pi-starship.toml"],
      },
      origin: "sync",
      runRoute: async (route, _signal, _onCommit, target) => {
        routes.push({ route, target });
        await routeGate;
        return { kind: "completed", outcome: "cancelled" };
      },
    });

    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.deepEqual(routes, [{ route: "push --force", target: "home" }]);
    releaseRoute();
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Synced content differs/u);
    tui.press("tui.select.cancel");
    assert.deepEqual(await running, { kind: "back" });
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("local-wins action refreshes when the reviewed setup identity changes", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["settings.json", "pi-starship.toml"]);
    const tui = createTuiHarness({ width: 80, rows: 20 });
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: tui.custom,
    });
    let routeCalls = 0;
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend, {
      origin: "push",
      runRoute: async () => {
        routeCalls += 1;
        return { kind: "completed", outcome: "applied" };
      },
    });

    await tui.waitForOpen();
    await updateLocalConfig((settings) => ({
      ...settings,
      syncSetups: {
        ...settings.syncSetups,
        home: {
          ...settings.syncSetups.home,
          sync: { ...settings.syncSetups.home.sync, automatic: true },
        },
      },
    }));
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.equal(routeCalls, 0);
    assert.match(notifications.at(-1)?.message ?? "", /Refreshing the comparison/u);
    tui.press("tui.select.cancel");
    await running;
  });
});

test("same and empty remote selections close with clear notices", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const emptyBackend = new MemorySyncBackend();
    let customCalls = 0;
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async () => {
        customCalls += 1;
        return undefined;
      },
    });

    await showRemoteSelectionReview(ctx, "home", undefined, () => emptyBackend);
    assert.match(notifications.at(-1)?.message ?? "", /no snapshot/u);

    const sameBackend = new MemorySyncBackend();
    await publishSelection(sameBackend, ["settings.json"]);
    await showRemoteSelectionReview(ctx, "home", undefined, () => sameBackend);
    assert.match(notifications.at(-1)?.message ?? "", /already matches/u);
    assert.equal(customCalls, 0);
  });
});

test("legacy remote selection offers read-only partial discovery", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const backend = new MemorySyncBackend();
    await backend.publishSnapshot(
      {
        ...snapshot([
          { path: "settings.json", content: Buffer.from("settings") },
          { path: "pi-starship.toml", content: Buffer.from("starship") },
        ]),
        id: "legacy",
      },
      { kind: "missing" },
    );
    const rendered: string[] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 80);
        harness.handleInput("tui.select.confirm");
        await harness.waitForPending();
        rendered.push(harness.render().join("\n"));
        harness.dispose();
        return harness.result;
      },
    });

    await showRemoteSelectionReview(ctx, "home", undefined, () => backend);

    assert.match(rendered.join("\n"), /partial.*pi-starship\.toml/is);
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("remote selection adoption refreshes a changed remote head and preserves settings", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["settings.json", "pi-starship.toml", "sessions"]);
    const tui = createTuiHarness({ width: 80, rows: 20 });
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: tui.custom,
      confirm: async () => {
        await publishSelection(backend, ["settings.json", "models.json"]);
        return true;
      },
    });
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend);

    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Synced content differs/u);
    assert.match(notifications.at(-1)?.message ?? "", /Refreshing the comparison/u);
    tui.press("tui.select.cancel");
    await running;
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("remote selection adoption refreshes a concurrent local include change", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const backend = new MutatingReadBackend(async () => {
      await updateLocalConfig((settings) => ({
        ...settings,
        syncSetups: {
          ...settings.syncSetups,
          home: {
            ...settings.syncSetups.home,
            sync: { ...settings.syncSetups.home.sync, include: ["models.json"] },
          },
        },
      }));
    });
    await publishSelection(backend, ["settings.json", "pi-starship.toml"]);
    const tui = createTuiHarness({ width: 80, rows: 20 });
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: tui.custom,
    });
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend);

    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.deepEqual((await readLocalConfigObject())?.syncSetups.home.sync.include, ["models.json"]);
    assert.match(notifications.at(-1)?.message ?? "", /Refreshing the comparison/u);
    tui.press("tui.select.cancel");
    await running;
  });
});

test("RPC remote selection review stays read-only", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["pi-starship.toml", "settings.json"]);
    const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });

    await showRemoteSelectionReview(ctx, "home", undefined, () => backend);

    assert.match(notifications.at(-1)?.message ?? "", /RPC review is read-only/u);
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("remote selection review disposes on session replacement without side effects", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const backend = new MemorySyncBackend();
    await publishSelection(backend, ["settings.json", "pi-starship.toml"]);
    const controller = new AbortController();
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 80);
        controller.abort(new DOMException("Session replaced", "AbortError"));
        harness.dispose();
        return harness.result;
      },
    });

    await showRemoteSelectionReview(ctx, "home", controller.signal, () => backend);

    assert.deepEqual(readFileSync(localConfigPath()), before);
    assert.deepEqual(notifications, []);
  });
});

class MutatingReadBackend extends MemorySyncBackend {
  private snapshotReads = 0;

  constructor(private readonly mutate: () => Promise<void>) {
    super();
  }

  override async readSnapshot(reference: string, signal?: AbortSignal) {
    this.snapshotReads += 1;
    if (this.snapshotReads === 2) await this.mutate();
    return super.readSnapshot(reference, signal);
  }
}

async function publishSelection(backend: MemorySyncBackend, include: string[]) {
  return backend.publishSnapshot(
    {
      ...snapshot([]),
      id: `selection-${include.join("-")}`,
      selection: { version: 1, include },
    },
    expectedRemoteHead(await backend.readHead()),
  );
}
