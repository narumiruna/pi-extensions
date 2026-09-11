import assert from "node:assert/strict";
import { test } from "vitest";
import { expectedRemoteHead, type SyncBackend, SyncBackendConflictError } from "../src/backends/sync-backend.js";
import { snapshot } from "./helpers.js";

interface BackendFixture {
  backend: SyncBackend;
  dispose?: () => void | Promise<void>;
}

type BackendFactory = () => SyncBackend | BackendFixture | Promise<SyncBackend | BackendFixture>;

export function registerSyncBackendContractSuite(name: string, create: BackendFactory) {
  test(`${name} contract: head, revision, snapshot, history, and diagnostics`, async () => {
    await withBackend(create, async (backend) => {
      assert.ok(backend.identity);
      assert.ok(backend.destination);
      assert.equal(await backend.readHead(), undefined);

      const first = {
        ...snapshot([{ path: "settings.json", content: Buffer.from("first") }]),
        selection: {
          version: 1 as const,
          include: ["settings.json", "remote-only.toml"],
        },
      };
      const firstResult = await backend.publishSnapshot(first, expectedRemoteHead(undefined));
      assert.equal(firstResult.head.snapshotId, first.id);
      assert.deepEqual(firstResult.head.selection, first.selection);
      assert.match(firstResult.head.revision, /\S/);
      assert.equal(backend.sameRevision(firstResult.head.revision, firstResult.head.revision), true);
      assert.deepEqual(await backend.readSnapshot(firstResult.head.snapshotRef), first);
      assert.deepEqual(await backend.listHistory(), [
        {
          snapshotRef: firstResult.head.snapshotRef,
          snapshotId: firstResult.head.snapshotId,
          createdAt: firstResult.head.createdAt,
          machine: firstResult.head.machine,
          syncSessions: firstResult.head.syncSessions,
        },
      ]);
      assert.ok((await backend.diagnose()).length > 0);

      const restored = { ...first, id: "restored", createdAt: "2026-01-02T00:00:00.000Z" };
      const restoredResult = await backend.publishSnapshot(restored, expectedRemoteHead(firstResult.head));
      assert.equal(backend.sameRevision(restoredResult.head.revision, firstResult.head.revision), false);
      assert.deepEqual(
        (await backend.listHistory()).map((entry) => entry.snapshotId),
        [first.id, restored.id],
      );
    });
  });

  test(`${name} contract: stale and missing-head expectations are typed conflicts`, async () => {
    await withBackend(create, async (backend) => {
      const first = snapshot([{ path: "settings.json", content: Buffer.from("first") }]);
      const head = (await backend.publishSnapshot(first, { kind: "missing" })).head;

      await assert.rejects(
        backend.publishSnapshot({ ...first, id: "stale" }, { kind: "missing" }),
        SyncBackendConflictError,
      );
      await assert.rejects(
        backend.publishSnapshot(
          { ...first, id: "wrong-revision" },
          { kind: "revision", revision: `${head.revision}-stale` },
        ),
        SyncBackendConflictError,
      );
      assert.equal((await backend.readHead())?.snapshotId, first.id);
    });
  });

  test(`${name} contract: cancellation before commit leaves the head unchanged`, async () => {
    await withBackend(create, async (backend) => {
      const controller = new AbortController();
      controller.abort(new DOMException("cancelled", "AbortError"));

      await assert.rejects(
        backend.publishSnapshot(snapshot([]), { kind: "missing" }, { signal: controller.signal }),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(await backend.readHead(), undefined);
    });
  });
}

async function withBackend(create: BackendFactory, run: (backend: SyncBackend) => Promise<void>) {
  const created = await create();
  const fixture = isFixture(created) ? created : { backend: created };
  try {
    await run(fixture.backend);
  } finally {
    await fixture.dispose?.();
  }
}

function isFixture(value: SyncBackend | BackendFixture): value is BackendFixture {
  return "backend" in value;
}
