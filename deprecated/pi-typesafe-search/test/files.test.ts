import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  discoverSearchFiles,
  isSensitiveFileName,
  loadTextFile,
  resolveSearchRoot,
  UnsupportedSearchFileError,
} from "../src/files.js";

async function withWorkspace(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-jev-files-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("discovery is deterministic and excludes symlinks, generated directories, and sensitive files", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(path.join(workspace, "src"));
    await mkdir(path.join(workspace, "node_modules"));
    await writeFile(path.join(workspace, "src", "b.ts"), "export const b = 2;\n");
    await writeFile(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(workspace, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(workspace, "node_modules", "ignored.js"), "ignored\n");
    await symlink(path.join(workspace, "src", "a.ts"), path.join(workspace, "linked.ts"));

    const result = await discoverSearchFiles(workspace, ".");
    assert.equal(result.workspacePrefix, "");
    assert.deepEqual(
      result.files.map((file) => file.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.equal(result.skippedDirectories, 1);
    assert.ok(result.skippedFiles >= 2);

    const nested = await discoverSearchFiles(workspace, "src");
    assert.equal(nested.workspacePrefix, "src");
    assert.deepEqual(
      nested.files.map((file) => file.path),
      ["a.ts", "b.ts"],
    );
  });
});

test("search roots remain inside the canonical workspace", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "pi-jev-outside-"));
    try {
      await symlink(outside, path.join(workspace, "outside"));
      await assert.rejects(resolveSearchRoot(workspace, "../"), /inside the current workspace/);
      await assert.rejects(resolveSearchRoot(workspace, "outside"), /outside the current workspace/);
      assert.equal(await resolveSearchRoot(workspace, "@."), await resolveSearchRoot(workspace, "."));
      assert.equal(await resolveSearchRoot(path.parse(workspace).root, workspace), await realpath(workspace));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("discovery excludes the Pi agent directory and extension settings", async () => {
  await withWorkspace(async (workspace) => {
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    const agentDirectory = path.join(workspace, ".pi-agent");
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    try {
      await mkdir(agentDirectory);
      await writeFile(path.join(agentDirectory, "pi-typesafe-search.json"), '{"apiKey":"secret"}\n');
      await writeFile(path.join(agentDirectory, "session.jsonl"), "private session\n");
      await writeFile(path.join(workspace, "visible.txt"), "public source\n");

      const discovery = await discoverSearchFiles(workspace, ".");
      assert.deepEqual(
        discovery.files.map((file) => file.path),
        ["visible.txt"],
      );
      assert.equal(discovery.skippedDirectories, 1);
      await assert.rejects(discoverSearchFiles(workspace, ".pi-agent"), /must not select the Pi agent directory/);
    } finally {
      if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
  });
});

test("safe loading decodes UTF-8, rejects unsupported or changed data, and honors cancellation", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "text.txt"), "alpha\r\nbeta\r\n");
    await writeFile(path.join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(workspace, "race.txt"), "old contents\n");
    await writeFile(path.join(workspace, "oversized.txt"), Buffer.alloc(512 * 1024 + 1, 97));
    const discovery = await discoverSearchFiles(workspace, ".");
    const text = discovery.files.find((file) => file.path === "text.txt");
    const binary = discovery.files.find((file) => file.path === "binary.bin");
    const invalid = discovery.files.find((file) => file.path === "invalid.txt");
    const raced = discovery.files.find((file) => file.path === "race.txt");
    assert.ok(text);
    assert.ok(binary);
    assert.ok(invalid);
    assert.ok(raced);
    assert.equal(
      discovery.files.some((file) => file.path === "oversized.txt"),
      false,
    );
    assert.deepEqual((await loadTextFile(text, discovery.root)).lines, ["alpha", "beta", ""]);
    await assert.rejects(loadTextFile(binary, discovery.root), UnsupportedSearchFileError);
    await assert.rejects(loadTextFile(invalid, discovery.root), UnsupportedSearchFileError);

    const replacementPath = path.join(workspace, "race.next");
    await writeFile(replacementPath, "new contents\n");
    let checks = 0;
    const replacementSignal = {
      aborted: false,
      throwIfAborted() {
        checks += 1;
        if (checks === 4) renameSync(replacementPath, path.join(workspace, "race.txt"));
      },
    } as AbortSignal;
    await assert.rejects(loadTextFile(raced, discovery.root, replacementSignal), /changed while it was read/);

    await writeFile(path.join(workspace, "text.txt"), "omega\r\nzeta\r\n");
    await utimes(path.join(workspace, "text.txt"), new Date(), new Date(Date.now() + 1_000));
    await assert.rejects(loadTextFile(text, discovery.root), /changed while it was being opened/);

    await writeFile(path.join(workspace, "text.txt"), "changed size after discovery\n");
    await assert.rejects(loadTextFile(text, discovery.root), /changed size|changed while it was being opened/);

    if (process.platform !== "win32") {
      await mkdir(path.join(workspace, "nested"));
      await writeFile(path.join(workspace, "nested", "source.txt"), "inside source\n");
      const nestedDiscovery = await discoverSearchFiles(workspace, "nested");
      const nestedFile = nestedDiscovery.files[0];
      assert.ok(nestedFile);
      const outside = await mkdtemp(path.join(os.tmpdir(), "pi-jev-swap-"));
      try {
        await writeFile(path.join(outside, "source.txt"), "outside source\n");
        await rm(path.join(workspace, "nested"), { recursive: true });
        await symlink(outside, path.join(workspace, "nested"));
        await assert.rejects(loadTextFile(nestedFile, nestedDiscovery.root), /changed path identity|escaped/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    }

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(discoverSearchFiles(workspace, ".", controller.signal), (error: unknown) =>
      Boolean(error instanceof Error && error.name === "AbortError"),
    );
  });
});

test("discovery rejects corpora beyond the configured byte budget", async () => {
  await withWorkspace(async (workspace) => {
    for (let index = 0; index < 101; index += 1) {
      const file = path.join(workspace, `${String(index).padStart(3, "0")}.txt`);
      await writeFile(file, "");
      await truncate(file, 512 * 1024);
    }
    await assert.rejects(discoverSearchFiles(workspace, "."), /byte index limit/);
  });
});

test("sensitive filename policy covers common credential material", () => {
  for (const name of [
    ".env",
    ".env.local",
    ".git-credentials",
    ".netrc",
    "credentials",
    "server.pem",
    "private.key",
    "id_rsa",
    "secrets.json",
    "token.secret",
    "pi-typesafe-search.json",
  ]) {
    assert.equal(isSensitiveFileName(name), true, name);
  }
  for (const name of ["environment.md", "keyboard.ts", ".github", "public.crt"]) {
    assert.equal(isSensitiveFileName(name), false, name);
  }
});
