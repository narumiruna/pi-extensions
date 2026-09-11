import assert from "node:assert/strict";
import { appendFile, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "vitest";
import { AnalyticsRunFiles } from "../src/storage/files.js";
import type { SettledRun } from "../src/types.js";

function run(id: string, startedAtMs = 1): SettledRun {
  return {
    id,
    startedAtMs,
    finishedAtMs: startedAtMs + 1,
    durationMs: 1,
    triggerSource: "interactive",
    outcome: "success",
    attemptCount: 1,
    generations: [],
    tools: [],
    skills: [],
    providerErrors: [],
    toolErrorCount: 0,
    providerErrorCount: 0,
    recoveredErrorCount: 0,
  };
}

async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-jsonl-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "pi-analytics");
}

async function collect(files: AnalyticsRunFiles, signal?: AbortSignal): Promise<SettledRun[]> {
  const result: SettledRun[] = [];
  for await (const item of files.read(signal)) result.push(item);
  return result;
}

async function currentWriter(root: string): Promise<string> {
  const generation = (await readFile(path.join(root, "current"), "utf8")).trim();
  const directory = path.join(root, "generations", generation);
  const writers = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(writers.length, 1);
  return path.join(directory, writers[0] ?? "missing");
}

test("construction and close perform no startup filesystem work", async (t) => {
  const root = await fixture(t);
  const files = new AnalyticsRunFiles(root);
  await files.close();
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("independent writers lazily append private frames without cross-process locks", async (t) => {
  const root = await fixture(t);
  const left = new AnalyticsRunFiles(root);
  const right = new AnalyticsRunFiles(root);
  await Promise.all([
    ...Array.from({ length: 10 }, (_, index) => left.append(run(`left-${index}`, index))),
    ...Array.from({ length: 10 }, (_, index) => right.append(run(`right-${index}`, index))),
  ]);
  const stored = await collect(left);
  assert.equal(stored.length, 20);
  assert.equal(new Set(stored.map(({ id }) => id)).size, 20);
  assert.equal((await readdir(path.join(root, "generations"))).length, 1);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, "current"))).mode & 0o777, 0o600);
    const generation = (await readFile(path.join(root, "current"), "utf8")).trim();
    for (const name of await readdir(path.join(root, "generations", generation))) {
      assert.equal((await stat(path.join(root, "generations", generation, name))).mode & 0o777, 0o600);
    }
  }
});

test("the default write deadline tolerates a transient local filesystem stall", async (t) => {
  const root = await fixture(t);
  const files = new AnalyticsRunFiles(root, {
    async beforeAppend() {
      await new Promise((resolve) => setTimeout(resolve, 750));
    },
  });
  await files.append(run("delayed"));
  assert.deepEqual(
    (await collect(files)).map(({ id }) => id),
    ["delayed"],
  );
});

test("reader ignores only a crash-truncated final frame and rejects completed corruption", async (t) => {
  const root = await fixture(t);
  const files = new AnalyticsRunFiles(root);
  await files.append(run("valid"));
  const writer = await currentWriter(root);
  await appendFile(writer, '{"formatVersion":1');
  assert.deepEqual(
    (await collect(files)).map(({ id }) => id),
    ["valid"],
  );
  await appendFile(writer, "\nnot-json\n");
  await assert.rejects(collect(files), /invalid JSON/i);
});

test("clear publishes a new generation and old writers follow it on their next append", async (t) => {
  const root = await fixture(t);
  const left = new AnalyticsRunFiles(root);
  const right = new AnalyticsRunFiles(root);
  await left.append(run("before"));
  const oldGeneration = (await readFile(path.join(root, "current"), "utf8")).trim();
  const cleared = await left.clear();
  await right.append(run("after"));
  const newGeneration = (await readFile(path.join(root, "current"), "utf8")).trim();
  assert.notEqual(newGeneration, oldGeneration);
  assert.deepEqual(
    (await collect(left)).map(({ id }) => id),
    ["after"],
  );
  assert.equal(cleared.cleanupIncomplete, false);
});

test("an append overlapping Clear revalidates and republishes into the active generation", async (t) => {
  const root = await fixture(t);
  const clearer = new AnalyticsRunFiles(root);
  await clearer.append(run("before"));
  let reached!: () => void;
  const atOldGeneration = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blockedOnce = false;
  const writer = new AnalyticsRunFiles(root, {
    async beforeAppend() {
      if (blockedOnce) return;
      blockedOnce = true;
      reached();
      await blocked;
    },
  });
  const appending = writer.append(run("racing"));
  await atOldGeneration;
  await clearer.clear();
  release();
  await appending;
  assert.deepEqual(
    (await collect(clearer)).map(({ id }) => id),
    ["racing"],
  );
  assert.equal((await readdir(path.join(root, "generations"))).length, 1);
});

test("a stalled append receives the bounded write cancellation signal", async (t) => {
  const root = await fixture(t);
  const files = new AnalyticsRunFiles(root, {
    writeTimeoutMs: 10,
    async beforeAppend(_generation, signal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("The operation was aborted", { cause: signal.reason }), {
                name: "AbortError",
              }),
            ),
          { once: true },
        );
      });
    },
  });
  await assert.rejects(files.append(run("timeout")), /timed out/i);
  assert.deepEqual(await collect(files), []);
  await files.close();
});

test("shutdown aborts and drains Clear cleanup after its generation commit", async (t) => {
  const root = await fixture(t);
  let reached!: () => void;
  const cleaning = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const files = new AnalyticsRunFiles(root, {
    async beforeCleanupEntry(signal) {
      reached();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  await files.append(run("before"));
  const clearing = files.clear();
  await cleaning;
  const closing = files.close();
  assert.deepEqual(await clearing, { cleanupIncomplete: true });
  await closing;
  const retry = new AnalyticsRunFiles(root);
  assert.deepEqual(await retry.clear(), { cleanupIncomplete: false });
  assert.equal((await readdir(path.join(root, "generations"))).length, 1);
  await retry.close();
});

test("concurrent Clears retain only the last published active generation", async (t) => {
  const root = await fixture(t);
  const left = new AnalyticsRunFiles(root);
  const right = new AnalyticsRunFiles(root);
  await left.append(run("before"));
  await Promise.all([left.clear(), right.clear()]);
  assert.deepEqual(await left.clear(), { cleanupIncomplete: false });
  assert.equal((await readdir(path.join(root, "generations"))).length, 1);
  assert.deepEqual(await collect(left), []);
});

test("pre-aborted writes and reads stop without creating storage", async (t) => {
  const root = await fixture(t);
  const files = new AnalyticsRunFiles(root);
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(files.append(run("cancelled"), controller.signal), /cancelled/);
  await assert.rejects(collect(files, controller.signal), /cancelled/);
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("storage rejects linked roots and malformed generation markers", async (t) => {
  const root = await fixture(t);
  const target = `${root}-target`;
  await writeFile(target, "do not touch");
  await symlink(target, root);
  await assert.rejects(new AnalyticsRunFiles(root).append(run("linked")), /regular director/i);
  assert.equal(await readFile(target, "utf8"), "do not touch");
  await rm(root);
  await new AnalyticsRunFiles(root).append(run("initial"));
  await writeFile(path.join(root, "current"), "../../escape\n");
  await assert.rejects(collect(new AnalyticsRunFiles(root)), /generation marker/i);
});
