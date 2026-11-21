import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, vi } from "vitest";
import { GitCommandError, runGit } from "../src/engine/backends/git/git-runner.js";
import {
  compileIgnoreRules,
  DEFAULT_IGNORE_FILENAME,
  DEFAULT_IGNORE_RULES,
  ignorePolicyFingerprint,
  MAX_IGNORE_BYTES,
  readIgnoreSource,
  validateIgnoreFilename,
} from "../src/engine/ignore/ignore-source.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-source-")));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("fallback defaults do not write; a present empty file overrides them", () =>
  fixture(async (root) => {
    const fallback = await readIgnoreSource(root);
    assert.equal(fallback.filename, DEFAULT_IGNORE_FILENAME);
    assert.equal(fallback.text, "/npm/\n/sessions/\n/auth.json\n/truth.json\n");
    assert.equal(fallback.present, false);
    assert.equal(fallback.identity, undefined);
    assert.deepEqual(await readIgnoreSource(root, DEFAULT_IGNORE_FILENAME), fallback);
    assert.deepEqual(await fs.readdir(root), []);
    await assert.rejects(readIgnoreSource(root, ".work.syncignore"), /\.work\.syncignore.*does not exist/u);

    const target = path.join(root, DEFAULT_IGNORE_FILENAME);
    await fs.writeFile(target, DEFAULT_IGNORE_RULES);
    const explicit = await readIgnoreSource(root);
    assert.equal(explicit.present, true);
    assert.equal(explicit.text, fallback.text);
    assert.notEqual(explicit.sourceDigest, fallback.sourceDigest);
    await fs.writeFile(target, "");
    const empty = await readIgnoreSource(root);
    assert.equal(empty.present, true);
    assert.equal(empty.text, "");
    assert.notEqual(empty.sourceDigest, explicit.sourceDigest);
  }));

test("source digest binds exact bytes and filename; identity detects atomic replacement with identical bytes", () =>
  fixture(async (root) => {
    const filename = ".work rules.syncignore";
    const target = path.join(root, filename);
    const text = "\uFEFF/work/\r\n";
    await fs.writeFile(target, text);
    const original = await readIgnoreSource(root, filename);
    assert.equal(original.text, text);
    assert.ok(original.identity);
    assert.deepEqual(await readIgnoreSource(root, filename), original);

    const otherName = ".other.syncignore";
    const other = path.join(root, otherName);
    await fs.writeFile(other, text);
    assert.notEqual((await readIgnoreSource(root, otherName)).sourceDigest, original.sourceDigest);
    await fs.rename(other, target);
    const replacement = await readIgnoreSource(root, filename);
    assert.equal(replacement.sourceDigest, original.sourceDigest);
    assert.notEqual(replacement.identity, original.identity);

    await fs.writeFile(target, "/work/\n");
    assert.notEqual((await readIgnoreSource(root, filename)).sourceDigest, original.sourceDigest);
  }));

test("filename checks reject traversal, aliases, and case variants of protected names", () => {
  for (const name of [".syncignore", ".work.syncignore", "Work rules.ignore"]) {
    assert.equal(validateIgnoreFilename(name), name);
  }
  for (const name of [
    undefined,
    null,
    123,
    "",
    ".",
    "..",
    "../bad",
    "./bad",
    "/tmp/bad",
    "folder/foo",
    "folder\\foo",
    "C:bad",
    " x",
    "x ",
    "x.",
    "x\n",
    "x\0",
    "x\u202e",
    "x".repeat(256),
    "CON.txt",
    "COM1 .rules",
    "CONIN$",
    "auth.json:rules",
    "AUTH~1.JSO",
    "Auth.JSON",
    "trust.json.lock",
    "settings.json",
    ".SYNCIGNORE",
    "pi-sync.json",
    ".pi-sync.json.tmp",
    "pi-sync.local.json",
    ".pi-sync-state-migration.lock",
    ".pisync",
    "PI-SYNC",
    ".git",
    ".env.local",
  ]) {
    assert.throws(() => validateIgnoreFilename(name), /sync\.ignoreFile/u, JSON.stringify(name));
  }
});

test("invalid text and large sources fail closed; the exact byte limit is allowed", () =>
  fixture(async (root) => {
    const target = path.join(root, DEFAULT_IGNORE_FILENAME);
    await fs.writeFile(target, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readIgnoreSource(root), /\.syncignore.*valid UTF-8/u);
    await fs.writeFile(target, "secret\0more");
    await assert.rejects(readIgnoreSource(root), /\.syncignore.*NUL/u);
    const text = "é".repeat(MAX_IGNORE_BYTES / 2);
    await fs.writeFile(target, text);
    assert.equal((await readIgnoreSource(root)).text, text);
    await fs.appendFile(target, "\n");
    await assert.rejects(readIgnoreSource(root), /\.syncignore.*byte limit/u);
  }));

test("directories, hard links, and a missing root are not an absent default", () =>
  fixture(async (root) => {
    const target = path.join(root, DEFAULT_IGNORE_FILENAME);
    await fs.mkdir(target);
    await assert.rejects(readIgnoreSource(root), /\.syncignore.*regular file/u);
    await fs.rmdir(target);
    const protectedFile = path.join(root, "auth.json");
    await fs.writeFile(protectedFile, "fixture secret");
    await fs.link(protectedFile, target);
    await assert.rejects(readIgnoreSource(root), /\.syncignore.*hard links/u);
    await assert.rejects(readIgnoreSource(path.join(root, "missing")), /\.syncignore.*could not verify/u);
  }));

test.skipIf(process.platform === "win32")("rejects symlinks, dangling links, symlinked roots, and FIFOs", () =>
  fixture(async (root) => {
    const target = path.join(root, DEFAULT_IGNORE_FILENAME);
    const regular = path.join(root, "fixture");
    await fs.writeFile(regular, "private\n");
    await fs.symlink(regular, target);
    await assert.rejects(readIgnoreSource(root), /\.syncignore.*symlinks/u);
    await fs.rm(regular);
    await assert.rejects(readIgnoreSource(root), /\.syncignore.*symlinks/u);
    await fs.rm(target);
    await fs.mkdir(regular);
    const alias = path.join(root, "alias");
    await fs.symlink(regular, alias, "dir");
    await assert.rejects(readIgnoreSource(alias), /\.syncignore.*not a regular directory/u);
    await promisify(execFile)("mkfifo", [target], { timeout: 1_000 });
    await assert.rejects(readIgnoreSource(root), /\.syncignore.*regular file/u);
  }),
);

test("rejects replacement between the initial stat and open", () =>
  fixture(async (root) => {
    const target = path.join(root, DEFAULT_IGNORE_FILENAME);
    const replacement = path.join(root, "replacement");
    await fs.writeFile(target, "old\n");
    await fs.writeFile(replacement, "new\n");
    const open = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.rename(replacement, target);
      return open(...args);
    });
    try {
      await assert.rejects(readIgnoreSource(root), /\.syncignore.*changed during the read/u);
    } finally {
      spy.mockRestore();
    }
  }));

test("a replacement installed during the byte read does not produce a source for the detached file", () =>
  fixture(async (root) => {
    const target = path.join(root, DEFAULT_IGNORE_FILENAME);
    const replacement = path.join(root, "replacement");
    await fs.writeFile(target, "old\n");
    await fs.writeFile(replacement, "new\n");
    const open = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const read = handle.read;
      vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
        await fs.rename(replacement, target);
        return Reflect.apply(read, handle, readArgs);
      });
      return handle;
    });
    try {
      await assert.rejects(readIgnoreSource(root), /\.syncignore.*changed during the read/u);
    } finally {
      spy.mockRestore();
    }
  }));

test("cancellation rejects before lookup and closes a handle already opened", () =>
  fixture(async (root) => {
    const cancellation = new Error("cancel ignore read");
    const controller = new AbortController();
    await assert.rejects(readIgnoreSource(root, undefined, AbortSignal.abort(cancellation)), (error) => {
      return error === cancellation;
    });
    await fs.writeFile(path.join(root, DEFAULT_IGNORE_FILENAME), "rule\n");
    const open = fs.open;
    let closed = false;
    const spy = vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const close = handle.close;
      handle.close = async () => {
        await close.call(handle);
        closed = true;
      };
      controller.abort(cancellation);
      return handle;
    });
    try {
      await assert.rejects(readIgnoreSource(root, undefined, controller.signal), (error) => error === cancellation);
      assert.equal(closed, true);
    } finally {
      spy.mockRestore();
    }
  }));

type PathFixture = { path: string; ignored: boolean; directory?: true };

async function compareWithGit(root: string, rules: string, cases: PathFixture[]) {
  await runGit(["-c", "init.templateDir=", "init", "--quiet"], { cwd: root });
  const emptyGlobalRules = path.join(root, ".git", "empty-excludes");
  await fs.writeFile(emptyGlobalRules, "");
  await fs.writeFile(path.join(root, ".gitignore"), rules);
  for (const candidate of cases) {
    if (candidate.directory) await fs.mkdir(path.join(root, candidate.path), { recursive: true });
  }
  const checked = await runGit(
    [
      "-c",
      `core.excludesFile=${emptyGlobalRules}`,
      "-c",
      "core.ignoreCase=false",
      "-c",
      "core.precomposeUnicode=false",
      "check-ignore",
      "--no-index",
      "-z",
      "--stdin",
    ],
    { cwd: root, input: `${cases.map((candidate) => candidate.path).join("\0")}\0` },
  ).catch((error: unknown) => {
    if (error instanceof GitCommandError && error.exitCode === 1) return { stdout: Buffer.alloc(0) };
    throw error;
  });
  const ignoredByGit = new Set(checked.stdout.toString("utf8").split("\0").filter(Boolean));
  const matches = compileIgnoreRules(rules);
  for (const candidate of cases) {
    assert.equal(ignoredByGit.has(candidate.path), candidate.ignored, `Git fixture: ${JSON.stringify(candidate.path)}`);
    assert.equal(matches(candidate.path, candidate.directory), candidate.ignored, JSON.stringify(candidate.path));
  }
}

test("unsupported escaped path separators refuse the entire rules source", () => {
  assert.throws(() => compileIgnoreRules("/safe/\nx/**\\/b\n"), /line 2.*escaped path separator/u);
  assert.throws(() => compileIgnoreRules("*\n!*/\n!**\\/b\n"), /line 3.*escaped path separator/u);
  assert.equal(compileIgnoreRules("# x/**\\/b\n\\#literal\n")("#literal"), true);
});

test("default root rules match Git's path and directory handling", () =>
  fixture((root) =>
    compareWithGit(root, DEFAULT_IGNORE_RULES, [
      { path: "npm", directory: true, ignored: true },
      { path: "npm/npm.json", ignored: true },
      { path: "nested/npm/npm.json", ignored: false },
      { path: "sessions", directory: true, ignored: true },
      { path: "sessions/project/a.jsonl", ignored: true },
      { path: "nested/sessions/a.jsonl", ignored: false },
      { path: "auth.json", ignored: true },
      { path: "Auth.json", ignored: false },
      { path: "nested/auth.json", ignored: false },
      { path: "truth.json", ignored: true },
      { path: "trust.json", ignored: false },
    ]),
  ));

test("Git parity for ordered negation, directory pruning, ranges, globstars, byte width, and literal spaces", () =>
  fixture((root) =>
    compareWithGit(
      root,
      [
        "\uFEFF# leading comment",
        "",
        "\\#literal",
        "\\!literal",
        "/root.only",
        "cache/  ",
        "/closed/",
        "!/closed/wanted",
        "/open/*",
        "!/open/wanted",
        "*.tmp",
        "!maybe.tmp",
        "maybe.tmp",
        "glob/**/keep?.[a-c]",
        "/contents/**",
        "bare   ",
        "space\\   ",
        " leading",
        "trail\t",
        "byte?.one",
        "byte??.two",
        "word[[:digit:]].md",
        "é.txt",
        "literal\\*",
      ].join("\r\n"),
      [
        { path: "# leading comment", ignored: false },
        { path: "#literal", ignored: true },
        { path: "!literal", ignored: true },
        { path: "root.only", ignored: true },
        { path: "nested/root.only", ignored: false },
        { path: "cache", ignored: false },
        { path: "nested/cache", directory: true, ignored: true },
        { path: "nested/cache/value", ignored: true },
        { path: "closed/wanted", ignored: true },
        { path: "open/wanted", ignored: false },
        { path: "open/other", ignored: true },
        { path: "maybe.tmp", ignored: true },
        { path: "maybe.TMP", ignored: false },
        { path: "glob/keep1.a", ignored: true },
        { path: "glob/sub/deeper/keep2.b", ignored: true },
        { path: "glob/sub/keep11.a", ignored: false },
        { path: "glob/sub/keep1.d", ignored: false },
        { path: "contents", directory: true, ignored: false },
        { path: "contents/item", ignored: true },
        { path: "bare", ignored: true },
        { path: "bare ", ignored: false },
        { path: "space", ignored: false },
        { path: "space ", ignored: true },
        { path: "space  ", ignored: false },
        { path: " leading", ignored: true },
        { path: "leading", ignored: false },
        { path: "trail\t", ignored: true },
        { path: "trail", ignored: false },
        { path: "byteé.one", ignored: false },
        { path: "byteé.two", ignored: true },
        { path: "word7.md", ignored: true },
        { path: "wordx.md", ignored: false },
        { path: "é.txt", ignored: true },
        { path: "É.txt", ignored: false },
        { path: "literal*", ignored: true },
        { path: "literalXXX", ignored: false },
      ],
    ),
  ));

test("matching rejects unsafe path spellings without trimming valid spaces and stays stable across cache batches", () => {
  const matches = compileIgnoreRules("/blocked/\n/ my path\\ \n");
  for (const candidate of ["", "/blocked", "./blocked", "allowed//x", "allowed/../blocked", "a\\b", "C:x", "a/"]) {
    assert.throws(() => matches(candidate), /canonical relative path/u, candidate);
  }
  assert.equal(matches(" my path "), true);
  assert.equal(matches("my path"), false);
  for (let index = 0; index < 600; index++) {
    assert.equal(matches(`blocked/sub/${index}`), true);
    assert.equal(matches(`allowed/sub/${index}`), false);
  }
  assert.equal(matches(`${"x/".repeat(2_047)}x`), false);
  assert.throws(() => matches("é".repeat(2_049)), /byte limit/u);
});

test("portable policy fingerprint binds rule order and session opt-in", () => {
  const rules = "*.txt\n!keep.txt\n";
  const fingerprint = ignorePolicyFingerprint(rules, false);
  assert.match(fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(ignorePolicyFingerprint(rules, false), fingerprint);
  assert.notEqual(ignorePolicyFingerprint(rules, true), fingerprint);
  assert.notEqual(ignorePolicyFingerprint("!keep.txt\n*.txt\n", false), fingerprint);
});
