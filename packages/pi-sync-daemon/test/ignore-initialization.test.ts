import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import {
  AutomaticIgnoreCreationUnavailable,
  checkAutomaticIgnoreCreation,
  initializeDefaultIgnoreSource,
  prepareDefaultIgnoreSource,
  readPendingIgnoreCreation,
} from "../src/engine/ignore/ignore-initialization.js";
import {
  DEFAULT_IGNORE_CREATION_RECORD,
  DEFAULT_IGNORE_FILENAME,
  DEFAULT_IGNORE_RULES,
  readIgnoreSource,
  validateIgnoreFilename,
} from "../src/engine/ignore/ignore-source.js";
import { isDeniedPath } from "../src/engine/paths.js";

const marker = DEFAULT_IGNORE_CREATION_RECORD;
const filename = DEFAULT_IGNORE_FILENAME;
const starter = DEFAULT_IGNORE_RULES;
const record = `pi-sync-ignore-creation-v1\n${starter}`;
const unfinished = /\.syncignore.*unfinished creation record/u;
const posixCreation = test.skipIf(process.platform !== "linux");

async function fixture(run: (root: string, target: string, markerPath: string) => Promise<void>) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-initialization-")));
  const root = path.join(parent, "agent");
  try {
    await fs.mkdir(root);
    await run(root, path.join(root, filename), path.join(root, marker));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

function exclusive(flags: string | number | undefined) {
  return typeof flags === "number" && (flags & constants.O_EXCL) !== 0;
}

async function assertMissing(target: string) {
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
}

test("reads do not create anything and an existing intentional empty default is never rewritten", () =>
  fixture(async (root, target, markerPath) => {
    assert.equal((await readIgnoreSource(root)).present, false);
    assert.deepEqual(await fs.readdir(root), []);
    const cancellation = new Error("cancel confirmed setup");
    await assert.rejects(initializeDefaultIgnoreSource(root, AbortSignal.abort(cancellation)), (error) => {
      return error === cancellation;
    });
    assert.deepEqual(await fs.readdir(root), []);
    await fs.writeFile(target, "");
    const before = await fs.lstat(target, { bigint: true });
    const result = await initializeDefaultIgnoreSource(root);
    const after = await fs.lstat(target, { bigint: true });
    assert.equal(result.text, "");
    assert.equal(result.present, true);
    assert.equal(before.ino, after.ino);
    assert.equal(before.ctimeNs, after.ctimeNs);
    await assertMissing(markerPath);
  }));

test("every marker kind blocks only default reads, regardless of file presence or contents", () =>
  fixture(async (root, target, markerPath) => {
    assert.ok(isDeniedPath(marker));
    assert.throws(() => validateIgnoreFilename(marker), /reserved filename/u);
    await fs.mkdir(markerPath);
    await assert.rejects(readIgnoreSource(root, filename), unfinished);
    await fs.rmdir(markerPath);
    await fs.writeFile(markerPath, "", { mode: 0o600 });
    await fs.writeFile(target, "");
    await assert.rejects(readIgnoreSource(root), unfinished);
    await fs.writeFile(target, starter);
    await assert.rejects(readIgnoreSource(root), unfinished);
    const other = ".work.syncignore";
    await assert.rejects(readIgnoreSource(root, other), /does not exist/u);
    await fs.writeFile(path.join(root, other), "");
    assert.equal((await readIgnoreSource(root, other)).text, "");
    assert.equal(await fs.readFile(markerPath, "utf8"), "");
  }));

test("a marker appearing during a normal read invalidates both an absent and a present source", () =>
  fixture(async (root, target, markerPath) => {
    const lstat = fs.lstat;
    const statSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (args[0] === target) {
        try {
          return await lstat(...args);
        } finally {
          await fs.writeFile(markerPath, record, { mode: 0o600 });
        }
      }
      return lstat(...args);
    });
    await assert.rejects(readIgnoreSource(root), unfinished);
    statSpy.mockRestore();
    await fs.unlink(markerPath);
    await fs.writeFile(target, "");
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === target) {
        const close = handle.close;
        handle.close = async () => {
          await close.call(handle);
          await fs.writeFile(markerPath, record, { mode: 0o600 });
        };
      }
      return handle;
    });
    await assert.rejects(readIgnoreSource(root), unfinished);
  }));

test.each(["missing", "pending", "partial"] as const)(
  "portable initialization handles %s creation without a directory anchor",
  (state) =>
    fixture(async (root, target, markerPath) => {
      if (state !== "missing") await fs.writeFile(markerPath, record, { mode: 0o600 });
      if (state === "partial") await fs.writeFile(target, "/npm/");
      const stat = fs.stat;
      const noAnchor = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        if (/^\/(?:proc\/self|dev)\/fd\//u.test(String(args[0]))) {
          throw Object.assign(new Error("no directory anchor"), { code: "ENOTDIR" });
        }
        return stat(...args);
      });
      try {
        await checkAutomaticIgnoreCreation(root, new AbortController().signal);
        if (state === "partial") {
          await assert.rejects(initializeDefaultIgnoreSource(root), /unfinished creation/u);
          await assert.rejects(readIgnoreSource(root), unfinished);
          assert.equal(await fs.readFile(target, "utf8"), "/npm/");
          assert.equal(await fs.readFile(markerPath, "utf8"), record);
        } else {
          const result = await initializeDefaultIgnoreSource(root);
          assert.equal(result.text, starter);
          assert.equal(await fs.readFile(target, "utf8"), starter);
          await assertMissing(markerPath);
        }
      } finally {
        noAnchor.mockRestore();
      }
    }),
);

posixCreation("a different supported record cannot replace the reviewed starter at commit", () =>
  fixture(async (root, target, markerPath) => {
    const signal = new AbortController().signal;
    const oldRecord = "pi-sync-ignore-creation-v1\n/npm/\n/sessions/\n/auth.json\n/truth.json\n";
    await fs.writeFile(markerPath, oldRecord, { mode: 0o600 });
    const { token } = await readPendingIgnoreCreation(root, signal);
    await fs.writeFile(markerPath, record, { mode: 0o600 });
    await assert.rejects(prepareDefaultIgnoreSource(root, signal, token), /changed during initialization/u);
    assert.equal(await fs.readFile(markerPath, "utf8"), record);
    await assertMissing(target);
    assert.equal((await fs.stat(markerPath)).mode & 0o777, 0o600);
  }),
);

posixCreation("a pre-upgrade record does not accept a different complete template", () =>
  fixture(async (root, target, markerPath) => {
    const oldRecord = "pi-sync-ignore-creation-v1\n/npm/\n/sessions/\n/auth.json\n/truth.json\n";
    await fs.writeFile(markerPath, oldRecord, { mode: 0o600 });
    await fs.writeFile(target, starter, { mode: 0o600 });
    await assert.rejects(initializeDefaultIgnoreSource(root), /restore the full starter rules recorded in/u);
    assert.equal(await fs.readFile(markerPath, "utf8"), oldRecord);
    assert.equal(await fs.readFile(target, "utf8"), starter);
    await assert.rejects(readIgnoreSource(root), unfinished);
  }),
);

test("confirmed calls share one complete default file and never touch alternatives", () =>
  fixture(async (root, target, markerPath) => {
    const alternative = path.join(root, ".work.syncignore");
    await fs.writeFile(alternative, "/work/\n");
    const first = await initializeDefaultIgnoreSource(root);
    assert.equal(first.present, true);
    assert.equal(first.text, starter);
    assert.equal(await fs.readFile(target, "utf8"), starter);
    assert.deepEqual(await initializeDefaultIgnoreSource(root), first);
    assert.equal(await fs.readFile(alternative, "utf8"), "/work/\n");
    await assertMissing(markerPath);
  }));

test.each(["active", "late"] as const)("an %s contender leaves the winner's file usable", (ordering) =>
  fixture(async (root, target, markerPath) => {
    const open = fs.open;
    const contenderAtMarker = Promise.withResolvers<void>();
    const releaseContender = Promise.withResolvers<void>();
    const winnerAtTarget = Promise.withResolvers<void>();
    const releaseWinner = Promise.withResolvers<void>();
    let pauseContender = true;
    let pauseWinner = ordering === "active";
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const name = path.basename(String(args[0]));
      if (name === marker && exclusive(args[1]) && pauseContender) {
        pauseContender = false;
        contenderAtMarker.resolve();
        await releaseContender.promise;
      }
      if (name === filename && exclusive(args[1]) && pauseWinner) {
        pauseWinner = false;
        winnerAtTarget.resolve();
        await releaseWinner.promise;
      }
      return open(...args);
    });
    const contender = initializeDefaultIgnoreSource(root);
    const attempts = [contender];
    try {
      await Promise.race([contenderAtMarker.promise, contender]);
      const winner = initializeDefaultIgnoreSource(root);
      attempts.push(winner);
      if (ordering === "active") await Promise.race([winnerAtTarget.promise, winner]);
      else await winner;
      releaseContender.resolve();
      await assert.rejects(contender, /appeared concurrently/u);
      if (ordering === "active") {
        assert.equal(await fs.readFile(markerPath, "utf8"), record);
        await assertMissing(target);
        await assert.rejects(readIgnoreSource(root), unfinished);
      }
      releaseWinner.resolve();
      const completed = await winner;
      assert.deepEqual(await readIgnoreSource(root), completed);
      assert.equal(await fs.readFile(target, "utf8"), starter);
      await assertMissing(markerPath);
    } finally {
      releaseWinner.resolve();
      releaseContender.resolve();
      await Promise.allSettled(attempts);
    }
  }),
);

test.each([
  { scenario: "with custom rules", contents: "external\n", cancelled: false },
  { scenario: "with no rules", contents: "", cancelled: false },
  { scenario: "during cancellation", contents: "external\n", cancelled: true },
])("a fresh target collision $scenario preserves the competitor for reviewed retry", ({ contents, cancelled }) =>
  fixture(async (root, target, markerPath) => {
    const controller = new AbortController();
    const reason = new Error("confirmed request was cancelled");
    const open = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === filename && exclusive(args[1])) {
        assert.equal(await fs.readFile(markerPath, "utf8"), record);
        await fs.writeFile(target, contents, { flag: "wx" });
        if (cancelled) controller.abort(reason);
      }
      return open(...args);
    });
    const attempt = initializeDefaultIgnoreSource(root, controller.signal);
    await assert.rejects(attempt, cancelled ? (error) => error === reason : /appeared concurrently/u);
    spy.mockRestore();
    await assertMissing(markerPath);
    const competitor = await readIgnoreSource(root);
    assert.equal(competitor.present, true);
    assert.equal(competitor.text, contents);
    assert.deepEqual(await initializeDefaultIgnoreSource(root), competitor);
    assert.equal(await fs.readFile(target, "utf8"), contents);
  }),
);

posixCreation.each(["resumed", "replaced"] as const)("a %s creation record is preserved after target EEXIST", (kind) =>
  fixture(async (root, target, markerPath) => {
    if (kind === "resumed") await fs.writeFile(markerPath, record, { mode: 0o600 });
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === filename && exclusive(args[1])) {
        await fs.writeFile(target, "external\n", { flag: "wx" });
        if (kind === "replaced") {
          const replacement = path.join(root, "replacement");
          await fs.writeFile(replacement, record, { mode: 0o600 });
          await fs.rename(replacement, markerPath);
        }
      }
      return open(...args);
    });
    await assert.rejects(initializeDefaultIgnoreSource(root), /appeared concurrently|changed during initialization/u);
    assert.equal(await fs.readFile(markerPath, "utf8"), record);
    assert.equal(await fs.readFile(target, "utf8"), "external\n");
    await assert.rejects(readIgnoreSource(root), unfinished);
  }),
);

posixCreation(
  "root replacement just before exclusive target open cannot leave an unmarked partial file in the new root",
  () =>
    fixture(async (root, target, markerPath) => {
      const detached = `${root}.detached`;
      const open = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (path.basename(String(args[0])) === filename && exclusive(args[1])) {
          await fs.rename(root, detached);
          await fs.mkdir(root);
        }
        return open(...args);
      });
      await assert.rejects(
        initializeDefaultIgnoreSource(root),
        /exact on-disk filename|changed during initialization/u,
      );
      await assertMissing(target);
      await assertMissing(markerPath);
      assert.equal(await fs.readFile(path.join(detached, marker), "utf8"), record);
      await assert.rejects(readIgnoreSource(detached), unfinished);
    }),
);

test.skipIf(process.platform === "win32")("a symlinked ancestor is not a writable root alias", () =>
  fixture(async (root) => {
    const alias = `${path.dirname(root)}/alias`;
    await fs.symlink(path.dirname(root), alias, "dir");
    await assert.rejects(initializeDefaultIgnoreSource(path.join(alias, path.basename(root))), /not canonical/u);
    assert.deepEqual(await fs.readdir(root), []);
  }),
);

posixCreation.each([marker, filename])(
  "a same-byte replacement of %s before record clearance is not accepted",
  (name) =>
    fixture(async (root, target, markerPath) => {
      const open = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (path.basename(String(args[0])) === filename && exclusive(args[1])) {
          const sync = handle.sync;
          handle.sync = async () => {
            await sync.call(handle);
            const temp = path.join(root, "external-replacement");
            const file = path.join(root, name);
            await fs.writeFile(temp, await fs.readFile(file), { mode: 0o600 });
            await fs.rename(temp, file);
          };
        }
        return handle;
      });
      await assert.rejects(initializeDefaultIgnoreSource(root), /changed during initialization/u);
      assert.equal(await fs.readFile(markerPath, "utf8"), record);
      assert.equal(await fs.readFile(target, "utf8"), starter);
      await assert.rejects(readIgnoreSource(root), unfinished);
    }),
);

posixCreation("an apparently valid marker replaced during restart verification cannot authorize a write", () =>
  fixture(async (root, target, markerPath) => {
    await fs.writeFile(markerPath, record, { mode: 0o600 });
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])) === marker) {
        const read = handle.read;
        handle.read = async (...readArgs: Parameters<FileHandle["read"]>) => {
          const result = await Reflect.apply(read, handle, readArgs);
          const temp = path.join(root, "external-replacement");
          await fs.writeFile(temp, "foreign record", { mode: 0o600 });
          await fs.rename(temp, markerPath);
          return result;
        };
      }
      return handle;
    });
    await assert.rejects(initializeDefaultIgnoreSource(root), /changed during initialization/u);
    assert.equal(await fs.readFile(markerPath, "utf8"), "foreign record");
    await assertMissing(target);
  }),
);

posixCreation.each(["malformed", "symlink", "hardlink", "public"])("refuses a %s record without removing it", (kind) =>
  fixture(async (root, target, markerPath) => {
    const elsewhere = path.join(root, "unrelated");
    if (kind === "malformed") {
      await fs.writeFile(markerPath, "partial marker", { mode: 0o600 });
    } else if (kind === "public") {
      await fs.writeFile(markerPath, record, { mode: 0o600 });
      await fs.chmod(markerPath, 0o644);
    } else {
      await fs.writeFile(elsewhere, record, { mode: 0o600 });
      if (kind === "symlink") await fs.symlink(elsewhere, markerPath);
      else await fs.link(elsewhere, markerPath);
    }
    const before = await fs.lstat(markerPath);
    await assert.rejects(initializeDefaultIgnoreSource(root), /unsafe|invalid creation record/u);
    assert.equal((await fs.lstat(markerPath)).ino, before.ino);
    await assertMissing(target);
  }),
);

posixCreation.each(["exclusive open", "publication"] as const)(
  "cancellation after record %s leaves a durable record and a resumable absent target",
  (phase) =>
    fixture(async (root, target, markerPath) => {
      const controller = new AbortController();
      const reason = new Error("confirmed request was cancelled");
      const open = fs.open;
      const handles: FileHandle[] = [];
      let directorySyncs = 0;
      const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        handles.push(handle);
        if (path.basename(String(args[0])) === marker && exclusive(args[1]) && phase === "exclusive open") {
          controller.abort(reason);
        }
        if (args[0] === root) {
          const sync = handle.sync;
          handle.sync = async () => {
            await sync.call(handle);
            if (++directorySyncs === 2 && phase === "publication") controller.abort(reason);
          };
        }
        return handle;
      });
      await assert.rejects(initializeDefaultIgnoreSource(root, controller.signal), (error) => error === reason);
      spy.mockRestore();
      assert.equal(directorySyncs, 2);
      assert.ok(handles.length > 0);
      assert.ok(handles.every((handle) => handle.fd === -1));
      assert.equal(await fs.readFile(markerPath, "utf8"), record);
      await assertMissing(target);
      await assert.rejects(readIgnoreSource(root), unfinished);
      assert.equal((await initializeDefaultIgnoreSource(root)).text, starter);
      await assertMissing(markerPath);
    }),
);

posixCreation.each(["exclusive open", "file flush", "directory flush", "handle close"] as const)(
  "cancellation at target %s leaves a complete starter and reports cancellation",
  (phase) =>
    fixture(async (root, target, markerPath) => {
      const controller = new AbortController();
      const reason = new Error("confirmed request was cancelled");
      const open = fs.open;
      const handles: FileHandle[] = [];
      let directorySyncs = 0;
      const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        handles.push(handle);
        if (path.basename(String(args[0])) === filename && exclusive(args[1])) {
          if (phase === "exclusive open") controller.abort(reason);
          const sync = handle.sync;
          handle.sync = async () => {
            await sync.call(handle);
            if (phase === "file flush") controller.abort(reason);
          };
          const close = handle.close;
          handle.close = async () => {
            await close.call(handle);
            if (phase === "handle close") controller.abort(reason);
          };
        }
        if (args[0] === root) {
          const sync = handle.sync;
          handle.sync = async () => {
            await sync.call(handle);
            if (++directorySyncs === 3 && phase === "directory flush") controller.abort(reason);
          };
        }
        return handle;
      });
      try {
        await assert.rejects(initializeDefaultIgnoreSource(root, controller.signal), (error) => error === reason);
      } finally {
        spy.mockRestore();
      }
      assert.equal(directorySyncs, 4);
      assert.ok(handles.every((handle) => handle.fd === -1));
      assert.equal(await fs.readFile(target, "utf8"), starter);
      await assertMissing(markerPath);
      const completed = await readIgnoreSource(root);
      assert.equal(completed.present, true);
      assert.deepEqual(await initializeDefaultIgnoreSource(root), completed);
    }),
);

posixCreation("fails without writing if directory fsync is unavailable", () =>
  fixture(async (root) => {
    const signal = new AbortController().signal;
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === root) {
        handle.sync = async () => {
          throw Object.assign(new Error("cannot flush directory"), { code: "EINVAL" });
        };
      }
      return handle;
    });
    const noFlush = { constructor: AutomaticIgnoreCreationUnavailable, message: /does not support flushing/u };
    await assert.rejects(checkAutomaticIgnoreCreation(root, signal), noFlush);
    await assert.rejects(initializeDefaultIgnoreSource(root), noFlush);
    assert.deepEqual(await fs.readdir(root), []);
  }),
);

posixCreation.each([false, true])("a file flush failure leaves the starter blocked (cancelled: %s)", (cancelled) =>
  fixture(async (root, target, markerPath) => {
    const controller = new AbortController();
    const reason = new Error("confirmed request was cancelled");
    const open = fs.open;
    let attemptedFlush = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])) === filename && exclusive(args[1])) {
        if (cancelled) controller.abort(reason);
        handle.sync = async () => {
          attemptedFlush = true;
          throw Object.assign(new Error("cannot flush starter"), { code: "EIO" });
        };
      }
      return handle;
    });
    try {
      const attempt = initializeDefaultIgnoreSource(root, controller.signal);
      await assert.rejects(attempt, cancelled ? (error) => error === reason : /could not safely create or flush/u);
    } finally {
      spy.mockRestore();
    }
    assert.ok(attemptedFlush);
    assert.equal(await fs.readFile(markerPath, "utf8"), record);
    assert.equal(await fs.readFile(target, "utf8"), starter);
    await assert.rejects(readIgnoreSource(root), unfinished);
    assert.equal((await initializeDefaultIgnoreSource(root)).text, starter);
    await assertMissing(markerPath);
  }),
);

const childScript = `
  import assert from 'node:assert/strict';
  import { constants } from 'node:fs';
  import fs from 'node:fs/promises';
  import { registerHooks } from 'node:module';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  const [root, modulePath, phase, marker, filename, starter] = process.argv.slice(1);
  const engine = pathToFileURL(path.dirname(path.dirname(modulePath)) + path.sep).href;
  registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(engine) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return next(specifier.slice(0, -3) + '.ts', context);
    }
    return next(specifier, context);
  } });
  const { initializeDefaultIgnoreSource } = await import(pathToFileURL(modulePath).href);
  const checkpoint = () => new Promise(() => {
    process.on('message', () => {});
    process.send({ phase });
  });
  const open = fs.open;
  fs.open = async (...args) => {
    const creatingTarget = path.basename(String(args[0])) === filename && (args[1] & constants.O_EXCL) !== 0;
    if (creatingTarget && phase === 'before-open') await checkpoint();
    if (creatingTarget && phase === 'target-eexist') {
      await fs.writeFile(path.join(root, filename), '', { flag: 'wx', mode: 0o600 });
      await assert.rejects(open(...args), { code: 'EEXIST' });
      await checkpoint();
    }
    const handle = await open(...args);
    if (creatingTarget && phase === 'after-open') await checkpoint();
    if (creatingTarget && phase === 'partial-write') {
      handle.writeFile = async (bytes) => {
        await handle.write(bytes.subarray(0, 5));
        await checkpoint();
      };
    }
    if (args[0] === root && phase === 'before-clear') {
      let syncs = 0;
      const sync = handle.sync;
      handle.sync = async () => {
        await sync.call(handle);
        if (++syncs === 3) {
          assert.equal(await fs.readFile(path.join(root, filename), 'utf8'), starter);
          assert.ok(await fs.stat(path.join(root, marker)));
          await checkpoint();
        }
      };
    }
    return handle;
  };
  await initializeDefaultIgnoreSource(root);
  process.exit(8);
`;

async function crashChild(root: string, phase: string) {
  const modulePath = fileURLToPath(new URL("../src/engine/ignore/ignore-initialization.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", childScript, root, modulePath, phase, marker, filename, starter],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  const ready = once(child, "message");
  const exit = once(child, "close");
  try {
    const result = await Promise.race([
      ready.then(([message]) => message),
      exit.then(([code]) => {
        throw new Error(`initializer child exited before ${phase} (${code}): ${stderr}`);
      }),
    ]);
    assert.deepEqual(result, { phase });
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
  assert.deepEqual(await exit, [null, "SIGKILL"]);
}

const crashPhases = ["before-open", "target-eexist", "after-open", "partial-write"];
if (process.platform === "linux") crashPhases.push("before-clear");

test.each(crashPhases)("a process crash at %s blocks ordinary reads and preserves ambiguous targets", (phase) =>
  fixture(async (root, target, markerPath) => {
    await crashChild(root, phase);
    assert.equal(await fs.readFile(markerPath, "utf8"), record);
    if (process.platform !== "win32") assert.equal((await fs.stat(markerPath)).mode & 0o777, 0o600);
    await assert.rejects(readIgnoreSource(root), unfinished);
    if (phase === "target-eexist" || phase === "after-open" || phase === "partial-write") {
      const partial = phase === "partial-write" ? starter.slice(0, 5) : "";
      assert.equal(await fs.readFile(target, "utf8"), partial);
      await assert.rejects(initializeDefaultIgnoreSource(root), /unfinished creation/u);
      assert.equal(await fs.readFile(target, "utf8"), partial);
      assert.equal(await fs.readFile(markerPath, "utf8"), record);
      await fs.rename(target, path.join(path.dirname(root), "syncignore.saved-evidence"));
    } else if (phase === "before-open") {
      await assertMissing(target);
    }
    const original = phase === "before-clear" ? await fs.stat(target) : undefined;
    const recovered = await initializeDefaultIgnoreSource(root);
    assert.equal(recovered.text, starter);
    assert.equal(recovered.present, true);
    if (original) assert.equal((await fs.stat(target)).ino, original.ino);
    assert.deepEqual(await readIgnoreSource(root), recovered);
    await assertMissing(markerPath);
  }),
);
