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

  for (const version of [2, 3])
    for (const localFields of [...(version === 3 ? [undefined] : []), [], ["machine"]]) {
      test(`${name} contract: portable snapshot v${version} round trip (${localFields?.join(",") || "empty policy"})`, async () => {
        await withBackend(create, async (backend) => {
          const portable = {
            ...snapshot([{ path: "settings.json", content: Buffer.from('{"theme":"dark"}\n') }]),
            version,
            ...(localFields !== undefined ? { localFields } : {}),
            selection: { version: 1 as const, include: ["settings.json"] },
          };
          const result = await backend.publishSnapshot(portable, { kind: "missing" });
          assert.deepEqual(await backend.readSnapshot(result.head.snapshotRef), portable);
          const restored = { ...portable, id: "portable-restored" };
          const next = await backend.publishSnapshot(restored, expectedRemoteHead(result.head));
          assert.deepEqual(await backend.readSnapshot(next.head.snapshotRef), restored);
          assert.deepEqual(
            (await backend.listHistory()).map((entry) => entry.snapshotId),
            [portable.id, restored.id],
          );
          if (localFields !== undefined)
            await assert.rejects(
              backend.publishSnapshot({ ...portable, version: 1 }, expectedRemoteHead(next.head)),
              /version 2/,
            );
          await assert.rejects(
            backend.publishSnapshot({ ...portable, localFields: ["__proto__"] }, expectedRemoteHead(next.head)),
            /localFields/,
          );
          await assert.rejects(
            backend.publishSnapshot({ ...portable, version: 999 }, expectedRemoteHead(next.head)),
            /snapshot/i,
          );
          assert.equal((await backend.readHead())?.snapshotId, restored.id);
        });
      });
    }

  test(`${name} contract: exclude-enabled snapshot and head round trip`, async () => {
    await withBackend(create, async (backend) => {
      const image = {
        ...snapshot([{ path: "skills/public.md", content: Buffer.from("public") }]),
        version: 4,
        selection: { version: 2 as const, include: ["skills"], exclude: ["skills/private"] },
      };
      const published = await backend.publishSnapshot(image, { kind: "missing" });
      assert.deepEqual(published.head.selection, image.selection);
      assert.deepEqual(await backend.readSnapshot(published.head.snapshotRef), image);
      await assert.rejects(
        backend.publishSnapshot(
          {
            ...image,
            id: "excluded-bytes",
            files: snapshot([{ path: "skills/private/a.md", content: Buffer.from("private") }]).files,
          },
          expectedRemoteHead(published.head),
        ),
        /excluded paths/,
      );
      assert.equal((await backend.readHead())?.snapshotId, image.id);
    });
  });

  test(`${name} contract: excluded root values never enter portable storage`, async () => {
    await withBackend(create, async (backend) => {
      const clean = {
        ...snapshot([{ path: "settings.json", content: Buffer.from('{"theme":"base"}') }]),
        version: 2,
        localFields: ["machine"],
      };
      const head = (await backend.publishSnapshot(clean, { kind: "missing" })).head;
      for (const filePath of ["settings.json", "Settings.json"]) {
        const invalid = {
          ...clean,
          files: snapshot([{ path: filePath, content: Buffer.from('{"machine":"DO_NOT_DISCLOSE"}') }]).files,
        };
        await assert.rejects(
          backend.publishSnapshot(invalid, expectedRemoteHead(head)),
          (error) =>
            error instanceof Error && /Portable snapshot/.test(error.message) && !/DO_NOT_DISCLOSE/.test(error.message),
        );
        assert.deepEqual(await backend.readHead(), head);
      }
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
