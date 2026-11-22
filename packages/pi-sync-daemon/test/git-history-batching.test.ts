import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, test, vi } from "vitest";
import { GitSyncBackend } from "../src/engine/backends/git/git-backend.js";
import { runGit } from "../src/engine/backends/git/git-runner.js";
import { GIT_MANIFEST_VERSION, MAX_GIT_MANIFEST_BYTES } from "../src/engine/backends/git/git-storage.js";
import { expectedRemoteHead, type RemoteHistoryEntry } from "../src/engine/backends/sync-backend.js";

vi.mock(import("../src/engine/backends/git/git-runner.js"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, runGit: vi.fn(original.runGit) };
});
const { runGit: realRunGit } = await vi.importActual<typeof import("../src/engine/backends/git/git-runner.js")>(
  "../src/engine/backends/git/git-runner.js",
);
const recordedGit = vi.mocked(runGit);
const branch = "pi-sync/test";
const directory = "archive : 🧪/nested";
const manifestPath = `${directory}/manifest.json`;

beforeEach(() => {
  recordedGit.mockReset();
});

interface Publication {
  bytes?: Buffer | string | null;
  extraPath?: string;
}

async function withHistory(
  count: number,
  publications: Readonly<Record<number, Publication>>,
  run: (backend: GitSyncBackend, entries: RemoteHistoryEntry[], root: string) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-git-history-batching-"));
  try {
    const remote = path.join(root, "remote.git");
    await realRunGit(["-c", "init.templateDir=", "init", "--bare", "--object-format=sha1", remote]);
    const entries: RemoteHistoryEntry[] = [];
    if (count > 0) {
      const marks = path.join(root, "marks");
      const input: Buffer[] = [];
      const append = (text: string) => input.push(Buffer.from(text));
      const addFile = (file: string, raw: Buffer | string) => {
        const bytes = Buffer.from(raw);
        append(`M 100644 inline ${file}\ndata ${bytes.length}\n`);
        input.push(bytes);
        append("\n");
      };
      const startCommit = (ref: string, mark: number) => {
        append(`commit ${ref}\nmark :${mark}\ncommitter pi-sync <pi-sync@localhost> 1767225600 +0000\ndata 5\ntest\n`);
      };
      for (let index = 0; index < count; index += 1) {
        if (index === 1) {
          startCommit("refs/heads/side", count + 1);
          append("from :1\ndeleteall\n");
          addFile("not-a-publication.txt", "only on the second parent");
          append("\n");
        }
        startCommit(`refs/heads/${branch}`, index + 1);
        if (index === 1) append(`merge :${count + 1}\n`);
        append("deleteall\n");
        const publication = publications[index];
        const slot = index % 3;
        const entry = {
          snapshotRef: "",
          snapshotId: `test-${slot}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, slot)).toISOString(),
          machine: `test-機器-${slot}`,
          syncSessions: slot % 2 === 0,
        };
        entries.push(entry);
        const manifest = JSON.stringify({
          version: GIT_MANIFEST_VERSION,
          snapshotVersion: 3,
          snapshotId: entry.snapshotId,
          createdAt: entry.createdAt,
          machine: entry.machine,
          syncSessions: entry.syncSessions,
          profile: "test",
          files: [],
        });
        if (publication?.bytes !== null) addFile(manifestPath, publication?.bytes ?? `${manifest}\n`);
        if (publication?.extraPath) addFile(publication.extraPath, "unexpected");
        append("\n");
      }
      await realRunGit(["fast-import", "--quiet", `--export-marks=${marks}`], {
        gitDir: remote,
        input: Buffer.concat(input),
      });
      const refs = new Map(
        (await fs.readFile(marks, "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.split(" ") as [string, string]),
      );
      for (const [index, entry] of entries.entries()) {
        const ref = refs.get(`:${index + 1}`);
        assert.ok(ref);
        assert.match(ref, /^[0-9a-f]{40}$/u);
        entry.snapshotRef = ref;
      }
    }
    const backend = new GitSyncBackend(
      { type: "git", profile: { kind: "git", remote }, destination: { branch, namespace: "test", directory } },
      { cacheRoot: path.join(root, "cache"), allowLocalRemotes: true },
    );
    await run(backend, entries, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("a verified Push retains the actual previous Git publication as the first parent History entry", () =>
  withHistory(0, {}, async (backend) => {
    const old = {
      version: 3,
      id: "old",
      createdAt: "2026-01-01T00:00:00Z",
      profile: "test",
      machine: "fixture",
      files: [],
    };
    const { head } = await backend.publishSnapshot(old, { kind: "missing" });
    const previous = await backend.listHistory();
    const next = await backend.publishSnapshot({ ...old, id: "new" }, expectedRemoteHead(head), {
      preservePreviousHead: true,
    });
    const history = await backend.listHistory();
    assert.deepEqual(history.slice(0, -1), previous);
    assert.equal(history.at(-1)?.snapshotRef, next.head.snapshotRef);
    assert.deepEqual(await backend.readSnapshot(head.snapshotRef), old);
  }));

function validationCalls() {
  return recordedGit.mock.calls.filter(([args]) => ["cat-file", "ls-tree", "show"].includes(args[0] ?? ""));
}

test.each([0, 20, 100])("validates %i first-parent publications without changing history or preview refs", (count) =>
  withHistory(count, {}, async (backend, expected) => {
    const history = await backend.listHistory();
    assert.deepEqual(history, expected);
    assert.deepEqual(
      history
        .slice(-20)
        .reverse()
        .map((entry) => entry.snapshotRef),
      expected
        .slice(-20)
        .reverse()
        .map((entry) => entry.snapshotRef),
    );
    const calls = validationCalls();
    assert.equal(calls.length, count + Math.ceil(count / 8));
    let processed = 0;
    for (let offset = 0; offset < count; offset += 8) {
      const group = expected.slice(offset, offset + 8);
      const [batch, ...trees] = calls.slice(processed, processed + group.length + 1);
      processed += group.length + 1;
      assert.deepEqual(batch?.[0], ["cat-file", "--batch"]);
      assert.equal(batch?.[1]?.input, `${group.map((entry) => `${entry.snapshotRef}:${manifestPath}`).join("\n")}\n`);
      assert.equal(batch?.[1]?.maxOutputBytes, group.length * (MAX_GIT_MANIFEST_BYTES + 96));
      assert.deepEqual(
        trees.map(([args]) => args),
        group.map((entry) => ["ls-tree", "-r", "-z", entry.snapshotRef]),
      );
    }
  }),
);

test("an old tree error wins over a later old manifest error", () =>
  withHistory(22, { 0: { extraPath: "extra.txt" }, 1: { bytes: "not JSON" } }, async (backend, expected) => {
    await assert.rejects(backend.listHistory(), { message: "Git publication tree has missing or extra files." });
    assert.deepEqual(
      validationCalls().map(([args]) => args),
      [
        ["cat-file", "--batch"],
        ["ls-tree", "-r", "-z", expected[0]?.snapshotRef],
      ],
    );
  }));

test("an excluded manifest still rejects an unsupported version before any trees are read", () =>
  withHistory(21, { 0: { bytes: '{"version":1}' } }, async (backend) => {
    await assert.rejects(backend.listHistory(), {
      message: "Git publication uses the unsupported pre-release gzip format; recreate this pi-sync-owned test branch.",
    });
    assert.deepEqual(
      validationCalls().map(([args]) => args),
      [["cat-file", "--batch"]],
    );
  }));

test.each([
  { label: "missing", publication: { bytes: null }, error: /does not exist in/u },
  {
    label: "non-blob",
    publication: { bytes: null, extraPath: `${manifestPath}/nested` },
    error: /manifest is malformed/u,
  },
  {
    label: "over the per-manifest limit but within the group limit",
    publication: { bytes: " ".repeat(MAX_GIT_MANIFEST_BYTES + 1) },
    error: /Git output exceeds the 1048576-byte limit\./u,
  },
])("keeps the legacy error and order for a manifest that is $label", ({ publication, error }) =>
  withHistory(3, { 1: publication }, async (backend, expected) => {
    const first = expected[0]?.snapshotRef;
    const second = expected[1]?.snapshotRef;
    await assert.rejects(backend.listHistory(), error);
    assert.deepEqual(
      validationCalls().map(([args]) => args),
      [
        ["cat-file", "--batch"],
        ["show", `${first}:${manifestPath}`],
        ["ls-tree", "-r", "-z", first],
        ["show", `${second}:${manifestPath}`],
      ],
    );
  }),
);

test.each(["command error", "malformed framing", "unexpected diagnostic"] as const)(
  "uses only the legacy path for a group with a batch-only %s",
  (failure) =>
    withHistory(9, {}, async (backend, expected) => {
      let batches = 0;
      recordedGit.mockImplementation(async (args, options) => {
        if (args[0] !== "cat-file" || ++batches !== 1) return realRunGit(args, options);
        if (failure === "command error") throw new Error("Git batch command failed");
        const result = await realRunGit(args, options);
        return failure === "malformed framing"
          ? { ...result, stdout: result.stdout.subarray(0, -1) }
          : { ...result, stderr: Buffer.from("warning") };
      });
      assert.deepEqual(await backend.listHistory(), expected);
      assert.deepEqual(
        validationCalls().map(([args]) => args),
        [
          ["cat-file", "--batch"],
          ...expected.slice(0, 8).flatMap(({ snapshotRef }) => [
            ["show", `${snapshotRef}:${manifestPath}`],
            ["ls-tree", "-r", "-z", snapshotRef],
          ]),
          ["cat-file", "--batch"],
          ["ls-tree", "-r", "-z", expected[8]?.snapshotRef],
        ],
      );
    }),
);

test("cancellation at successful batch completion prevents tree validation", () =>
  withHistory(9, {}, async (backend) => {
    const abort = new AbortController();
    const reason = new Error("History cancelled");
    recordedGit.mockImplementation(async (args, options) => {
      const result = await realRunGit(args, options);
      if (args[0] === "cat-file") abort.abort(reason);
      return result;
    });
    await assert.rejects(backend.listHistory(abort.signal), (error) => error === reason);
    assert.deepEqual(
      validationCalls().map(([args]) => args),
      [["cat-file", "--batch"]],
    );
  }));

test.skipIf(process.platform === "win32")(
  "cancellation closes and joins the batch without falling back",
  ({ signal }) =>
    withHistory(9, {}, async (backend, expected, root) => {
      const ready = path.join(root, "ready");
      const stopped = path.join(root, "stopped");
      await fs.writeFile(
        path.join(root, "git"),
        `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(stopped)}, 'SIGTERM');
  process.exit(0);
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  setInterval(() => {}, 1000);
  const ready = ${JSON.stringify(ready)};
  fs.writeFileSync(ready + '.tmp', JSON.stringify({ pid: process.pid, input }));
  fs.renameSync(ready + '.tmp', ready);
});
`,
        { mode: 0o700 },
      );
      recordedGit.mockImplementation((args, options) =>
        realRunGit(
          args,
          args[0] === "cat-file"
            ? { ...options, env: { PATH: `${root}${path.delimiter}${process.env.PATH}` } }
            : options,
        ),
      );
      const abort = new AbortController();
      const reason = new Error("History cancelled");
      const result = assert.rejects(
        backend.listHistory(AbortSignal.any([abort.signal, signal])),
        (error) => error === reason,
      );
      try {
        const report = await Promise.race([
          waitForFile(ready, abort.signal),
          result.then(() => {
            throw new Error("Git batch did not reach its stdin EOF handshake");
          }),
        ]);
        const { pid, input } = JSON.parse(report) as { pid: number; input: string };
        assert.equal(
          input,
          `${expected
            .slice(0, 8)
            .map((entry) => `${entry.snapshotRef}:${manifestPath}`)
            .join("\n")}\n`,
        );
        abort.abort(reason);
        await result;
        assert.equal(await fs.readFile(stopped, "utf8"), "SIGTERM");
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        assert.deepEqual(
          validationCalls().map(([args]) => args),
          [["cat-file", "--batch"]],
        );
      } finally {
        abort.abort(reason);
        await result;
      }
    }),
);

async function waitForFile(file: string, signal: AbortSignal) {
  for (;;) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(5, undefined, { signal });
  }
}
