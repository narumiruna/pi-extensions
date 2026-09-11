import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { expectedRemoteHead } from "../src/backends/sync-backend.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import type { Snapshot } from "../src/snapshot/snapshot-types.js";
import { statePathForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { SyncDecisionRequiredError } from "../src/sync/sync-decision.js";
import { inspectSync } from "../src/sync/sync-inspection.js";
import { pull, push, status, syncBoth } from "../src/sync/sync-operations.js";
import { RemoteSelectionMismatchError } from "../src/sync/sync-policy.js";
import sync from "../src/sync.js";
import { classifyObservation } from "../src/ui/sync-attention.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

const options: CommandOptions = {
  yes: true,
  force: false,
  stale: false,
  silent: false,
  reload: false,
  auto: false,
  args: [],
};

test("sync and pull pause without mutation when remote included content differs", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
    const backend = new MemorySyncBackend();
    const remote = {
      ...snapshot([
        { path: "settings.json", content: Buffer.from('{"remote":true}\n') },
        { path: "pi-starship.toml", content: Buffer.from("remote-only\n") },
      ]),
      id: "remote-selection",
      selection: {
        version: 1 as const,
        include: ["settings.json", "pi-starship.toml"],
      },
    };
    await backend.publishSnapshot(remote, { kind: "missing" });
    const { ctx, notifications } = createMockContext({ hasUI: true, mode: "tui" });

    for (const operation of [
      () => syncBoth(ctx, { ...options, auto: true }, () => backend),
      () => pull(ctx, { ...options, force: true }, () => backend),
    ]) {
      await assert.rejects(operation(), RemoteSelectionMismatchError);
    }
    await status(ctx, options, () => backend);
    assert.match(notifications.at(-1)?.message ?? "", /remote included content: differs/i);
    assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"local":true}\n');
    assert.equal(existsSync(path.join(agentDir, "pi-starship.toml")), false);
    assert.equal(existsSync(statePathForConfig(await loadConfig())), false);
  });
});

test("ordinary push checks a differing head policy even when legacy state matches its snapshot", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const base = Buffer.from('{"base":true}\n');
    writeFileSync(path.join(agentDir, "settings.json"), base);
    const backend = new MemorySyncBackend();
    const remote = {
      ...snapshot([
        { path: "settings.json", content: base },
        { path: "pi-starship.toml", content: Buffer.from("remote-only\n") },
      ]),
      id: "remote-selection",
      selection: {
        version: 1 as const,
        include: ["settings.json", "pi-starship.toml"],
      },
    };
    const published = await backend.publishSnapshot(remote, { kind: "missing" });
    const config = await loadConfig();
    await writeStateForConfig(config, {
      version: 1,
      profile: config.snapshotIdentity,
      lastAppliedSnapshot: remote.id,
      lastRemoteRevision: published.head.revision,
      lastFileHashes: { "settings.json": remote.files[0]?.sha256 ?? "" },
      include: ["settings.json"],
    });
    writeFileSync(path.join(agentDir, "settings.json"), '{"changed":true}\n');
    const headBefore = await backend.readHead();
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

    await assert.rejects(
      push(ctx, options, undefined, () => backend),
      RemoteSelectionMismatchError,
    );
    assert.equal((await backend.readHead())?.revision, headBefore?.revision);
    assert.deepEqual((await backend.readSnapshot(remote.id)).selection, remote.selection);
  });
});

test("reviewed force push keeps local selection and preserves remote unmanaged files", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
    const backend = new MemorySyncBackend();
    await backend.publishSnapshot(
      {
        ...snapshot([
          { path: "settings.json", content: Buffer.from('{"remote":true}\n') },
          { path: "pi-starship.toml", content: Buffer.from("preserved\n") },
        ]),
        id: "remote-selection",
        selection: {
          version: 1,
          include: ["settings.json", "pi-starship.toml"],
        },
      },
      { kind: "missing" },
    );
    const reviews: string[] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async (_title: string, message: string) => {
        reviews.push(message);
        return true;
      },
    });

    await push(ctx, { ...options, yes: false, force: true }, undefined, () => backend);
    const head = await backend.readHead();
    assert.ok(head);
    const published = await backend.readSnapshot(head.snapshotRef);
    assert.deepEqual(published.selection, { version: 1, include: ["settings.json"] });
    assert.match(reviews.join("\n"), /replace the differing remote selection/i);
    assert.deepEqual(published.files.map((file) => file.path).sort(), ["pi-starship.toml", "settings.json"]);
  });
});

test("push reports a structured remote-or-policy decision without mutation", async () => {
  await withInitializedSync(async ({ agentDir, backend, config }) => {
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":"changed"}\n');
    writeFileSync(path.join(agentDir, "AGENTS.md"), "local policy addition\n");
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["settings.json", "AGENTS.md"] })), {
      mode: 0o600,
    });
    const remote = namedSnapshot("remote-change", '{"remote":"changed"}\n');
    await backend.publishSnapshot(remote, expectedRemoteHead(await backend.readHead()));
    const headBefore = await backend.readHead();

    await assert.rejects(pushContext(backend), (error: unknown) => {
      assert.ok(error instanceof SyncDecisionRequiredError);
      assert.equal(error.decision.kind, "remote-or-policy-changed");
      assert.equal(error.decision.setupName, "home");
      assert.deepEqual(error.decision.directions, ["push", "pull"]);
      assert.equal(error.decision.causes.localChanged, true);
      assert.equal(error.decision.causes.remoteChanged, true);
      assert.equal(error.decision.causes.policyChanged, true);
      assert.deepEqual(error.decision.previousInclude, ["settings.json"]);
      assert.deepEqual(error.decision.currentInclude, ["settings.json", "AGENTS.md"]);
      assert.match(error.decision.review, /Different: settings\.json/u);
      return true;
    });
    assert.equal((await backend.readHead())?.revision, headBefore?.revision);
    assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"local":"changed"}\n');
    assert.equal(existsSync(statePathForConfig(config)), true);
  });
});

test("pull and Sync now report structured both-changed decisions without mutation", async () => {
  await withInitializedSync(async ({ agentDir, backend }) => {
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":"changed"}\n');
    const remote = namedSnapshot("remote-change", '{"remote":"changed"}\n');
    await backend.publishSnapshot(remote, expectedRemoteHead(await backend.readHead()));
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
    for (const operation of [pull, syncBoth]) {
      await assert.rejects(
        operation(ctx, options, () => backend),
        (error: unknown) => {
          assert.ok(error instanceof SyncDecisionRequiredError);
          assert.equal(error.decision.kind, "both-changed");
          assert.deepEqual(error.decision.directions, ["push", "pull"]);
          assert.match(error.decision.review, /Different: settings\.json/u);
          return true;
        },
      );
    }
    assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"local":"changed"}\n');
    assert.equal((await backend.readHead())?.snapshotId, "remote-change");
  });
});

test("forced pull reuses backup and apply safeguards after a decision", async () => {
  await withInitializedSync(async ({ agentDir, backend }) => {
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":"changed"}\n');
    const remote = namedSnapshot("remote-change", '{"remote":"changed"}\n');
    await backend.publishSnapshot(remote, expectedRemoteHead(await backend.readHead()));
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

    const outcome = await pull(ctx, { ...options, force: true }, () => backend);
    assert.equal(outcome, "applied");
    assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"remote":"changed"}\n');
    assert.ok(readdirSync(path.join(agentDir, "pi-sync", "backups")).length > 0);
  });
});

test("forced push still refuses secrets after a decision", async () => {
  await withInitializedSync(async ({ agentDir, backend }) => {
    writeFileSync(path.join(agentDir, "settings.json"), '{"note":"OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456"}\n');
    const remote = namedSnapshot("remote-change", '{"remote":"changed"}\n');
    await backend.publishSnapshot(remote, expectedRemoteHead(await backend.readHead()));
    const headBefore = await backend.readHead();
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

    await assert.rejects(
      push(ctx, { ...options, force: true }, undefined, () => backend),
      /Refusing to push possible secrets/u,
    );
    assert.equal((await backend.readHead())?.revision, headBefore?.revision);
  });
});

test("first sync reports different settings as an initial-source decision", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
    const backend = new MemorySyncBackend();
    await backend.publishSnapshot(namedSnapshot("remote", '{"remote":true}\n'), {
      kind: "missing",
    });
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

    await assert.rejects(
      syncBoth(ctx, options, () => backend),
      (error: unknown) => {
        assert.ok(error instanceof SyncDecisionRequiredError);
        assert.equal(error.decision.kind, "first-sync-settings-diverged");
        assert.match(error.decision.review, /first sync/u);
        return true;
      },
    );
    assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"local":true}\n');
    assert.equal(existsSync(statePathForConfig(await loadConfig())), false);
  });
});

test("first sync reports different sessions as an initial-source decision", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["settings.json", "sessions"] })), {
      mode: 0o600,
    });
    writeFileSync(path.join(agentDir, "settings.json"), '{"same":true}\n');
    writeFileSync(path.join(agentDir, "sessions", "one.jsonl"), '{"local":true}\n');
    const backend = new MemorySyncBackend();
    const remote = snapshot([
      { path: "settings.json", content: Buffer.from('{"same":true}\n') },
      { path: "sessions/one.jsonl", content: Buffer.from('{"remote":true}\n') },
    ]);
    await backend.publishSnapshot({ ...remote, id: "remote", syncSessions: true }, { kind: "missing" });
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

    await assert.rejects(
      syncBoth(ctx, options, () => backend),
      (error: unknown) => {
        assert.ok(error instanceof SyncDecisionRequiredError);
        assert.equal(error.decision.kind, "first-sync-sessions-diverged");
        assert.match(error.decision.review, /sessions differ/u);
        return true;
      },
    );
    assert.equal(readFileSync(path.join(agentDir, "sessions", "one.jsonl"), "utf8"), '{"local":true}\n');
  });
});

test("startup check reports missing baseline without predicting a directional conflict", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })), {
      mode: 0o600,
    });
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
    const remote = { ...namedSnapshot("remote", '{"remote":true}\n'), profile: "home" };
    const encoded = gzipSync(Buffer.from(JSON.stringify(remote)));
    const pointer = {
      version: 1,
      profile: "home",
      snapshot: remote.id,
      sha256: createHash("sha256").update(encoded).digest("hex"),
      createdAt: remote.createdAt,
      machine: remote.machine,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/latest.json")) {
        return Response.json(pointer, { headers: { etag: '"latest"' } });
      }
      if (url.pathname.includes("/snapshots/")) {
        return new Response(new Uint8Array(encoded), { headers: { etag: '"snapshot"' } });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
    let customCalls = 0;
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "rpc",
      custom: async () => {
        customCalls += 1;
        return undefined;
      },
    });
    const { observeCheckCompletion } = await import("./startup-check-helpers.js");
    const completion = observeCheckCompletion(ctx);
    try {
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      await completion.completed;
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(customCalls, 0);
    assert.match(notifications.at(-1)?.message ?? "", /No sync baseline; review remote and local content/u);
    assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"local":true}\n');
  });
});

test("direct pull retains its actionable notification instead of opening recovery UI", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 404 });
    try {
      await mock.commands.get("sync")?.handler("pull", ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.match(
      notifications.at(-1)?.message ?? "",
      /Remote is empty\. Run \/sync push from a configured machine first/u,
    );
  });
});

test("push reports confirmation cancellation without publishing", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
    const backend = new MemorySyncBackend();
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => false,
    });

    assert.equal(await push(ctx, { ...options, yes: false }, undefined, () => backend), "cancelled");
    assert.equal(await backend.readHead(), undefined);
  });
});

test("pull from an empty remote offers only a structured push decision", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
    const backend = new MemorySyncBackend();
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

    await assert.rejects(
      pull(ctx, options, () => backend),
      (error: unknown) => {
        assert.ok(error instanceof SyncDecisionRequiredError);
        assert.equal(error.decision.kind, "remote-empty");
        assert.deepEqual(error.decision.directions, ["push"]);
        assert.match(error.decision.review, /Add: settings\.json/u);
        return true;
      },
    );
    assert.equal(await backend.readHead(), undefined);
  });
});

test("order-only selection differences still block sync, forced pull, and ordinary push", async () => {
  await withInitializedSync(async ({ backend }) => {
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["settings.json", "AGENTS.md"] })));
    const remote = {
      ...namedSnapshot("reordered", '{"base":true}\n'),
      selection: { version: 1 as const, include: ["AGENTS.md", "settings.json"] },
    };
    await backend.publishSnapshot(remote, expectedRemoteHead(await backend.readHead()));
    const before = await backend.readHead();
    const { ctx } = createMockContext({ mode: "tui" });
    for (const run of [
      () => syncBoth(ctx, options, () => backend),
      () => pull(ctx, { ...options, force: true }, () => backend),
      () => push(ctx, options, undefined, () => backend),
    ]) {
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof RemoteSelectionMismatchError);
        assert.match(error.message, /Only ordering differs/u);
        return true;
      });
    }
    assert.deepEqual(await backend.readHead(), before);
  });
});

for (const legacy of [false, true]) {
  test(`status-only remote change legacy=${legacy} still requires pull confirmation`, async () => {
    await withInitializedSync(async ({ agentDir, backend, config }) => {
      const remote = {
        ...namedSnapshot("remote-change", '{"remote":true}\n'),
        ...(legacy ? {} : { selection: { version: 1 as const, include: config.include } }),
      };
      await backend.publishSnapshot(remote, expectedRemoteHead(await backend.readHead()));
      const inspection = await inspectSync(config, { include: config.include }, undefined, () => backend);
      assert.equal(inspection.selectionState?.kind, legacy ? "legacy" : "same");
      assert.equal(
        classifyObservation({
          setupName: config.setupName,
          configIdentity: "test",
          checkedAt: "test",
          inspection,
        }),
        "status",
      );
      const stateBefore = readFileSync(statePathForConfig(config));
      let confirmations = 0;
      const { ctx } = createMockContext({
        mode: "tui",
        confirm: async () => {
          confirmations++;
          return false;
        },
      });
      assert.equal(await pull(ctx, { ...options, yes: false }, () => backend), "cancelled");
      assert.equal(confirmations, 1);
      assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"base":true}\n');
      assert.deepEqual(readFileSync(statePathForConfig(config)), stateBefore);
      assert.equal((await backend.readHead())?.snapshotId, "remote-change");
    });
  });
}

async function withInitializedSync(
  run: (state: {
    agentDir: string;
    backend: MemorySyncBackend;
    config: Awaited<ReturnType<typeof loadConfig>>;
  }) => Promise<void>,
) {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    writeFileSync(path.join(agentDir, "settings.json"), '{"base":true}\n');
    const backend = new MemorySyncBackend();
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
    await push(ctx, options, undefined, () => backend);
    await run({ agentDir, backend, config: await loadConfig() });
  });
}

function pushContext(backend: MemorySyncBackend) {
  const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
  return push(ctx, options, undefined, () => backend);
}

function namedSnapshot(id: string, content: string): Snapshot {
  return { ...snapshot([{ path: "settings.json", content: Buffer.from(content) }]), id };
}
