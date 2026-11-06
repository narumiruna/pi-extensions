import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import {
  createLocalConfigDocument,
  localConfigPath,
  withConfigPublicationReadyHookForTest,
  withConfigReplacementInstalledHookForTest,
  withLocalConfigFileLock,
} from "../src/settings/config-file.js";
import { readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const existing of [false, true]) {
  test(`cancellation immediately before publication preserves prior settings (existing file: ${existing})`, async () => {
    await withTempHome(async (agentDir) => {
      const before = Buffer.from(`${JSON.stringify({ ...v3S3Settings(), debug: false })}\n`);
      if (existing) {
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(localConfigPath(), before, { mode: 0o600 });
      }
      const controller = new AbortController();
      await assert.rejects(
        withConfigPublicationReadyHookForTest(
          async () => {
            if (existing) assert.deepEqual(await fs.readFile(localConfigPath()), before);
            else await assert.rejects(fs.access(localConfigPath()), { code: "ENOENT" });
            controller.abort(new DOMException("Session replaced", "AbortError"));
          },
          async () => {
            if (existing) await updateLocalConfig((settings) => ({ ...settings, debug: true }), controller.signal);
            else await createLocalConfigDocument({ ...v3S3Settings(), debug: true }, controller.signal);
          },
        ),
        { name: "AbortError" },
      );
      if (existing) assert.deepEqual(await fs.readFile(localConfigPath()), before);
      else await assert.rejects(fs.access(localConfigPath()), { code: "ENOENT" });
      assert.deepEqual(
        (await fs.readdir(agentDir)).filter((name) => name.startsWith(".pi-sync.json.")),
        [],
      );
      await updateLocalConfig((settings) => ({ ...settings, debug: true }));
      assert.equal((await readLocalConfigObject())?.debug, true);
    });
  });

  test(`cancellation after the atomic rename keeps the committed save (existing file: ${existing})`, async () => {
    await withTempHome(async (agentDir) => {
      if (existing) {
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(localConfigPath(), JSON.stringify({ ...v3S3Settings(), debug: false }), { mode: 0o600 });
      }
      const controller = new AbortController();
      const original = fs.rename.bind(fs);
      const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[1] === localConfigPath()) controller.abort();
        return result;
      });
      try {
        if (existing) await updateLocalConfig((settings) => ({ ...settings, debug: true }), controller.signal);
        else await createLocalConfigDocument({ ...v3S3Settings(), debug: true }, controller.signal);
        assert.equal(controller.signal.aborted, true);
        assert.equal((await readLocalConfigObject())?.debug, true);
      } finally {
        rename.mockRestore();
      }
    });
  });
}

test("first creation rechecks cancellation after waiting for the cross-process lock", async () => {
  await withTempHome(async () => {
    let reportHeld: () => void = () => undefined;
    let releaseLock: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      reportHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = withLocalConfigFileLock(async () => {
      reportHeld();
      await release;
    });
    await held;
    const controller = new AbortController();
    const create = createLocalConfigDocument(v3S3Settings(), controller.signal);
    const rejected = assert.rejects(create, { name: "AbortError" });
    try {
      controller.abort();
      releaseLock();
      await blocker;
      await rejected;
      assert.equal(await readLocalConfigObject(), undefined);
    } finally {
      releaseLock();
      await Promise.allSettled([blocker, create]);
    }
  });
});

test("a replacement staging failure preserves canonical bytes and removes its unused recovery copy", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    await fs.writeFile(localConfigPath(), before, { mode: 0o600 });
    const original = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".migrate")) throw new Error("injected staging failure");
      return original(...args);
    });
    try {
      await assert.rejects(
        updateLocalConfig((settings) => ({ ...settings, debug: true })),
        /injected staging failure/u,
      );
      assert.deepEqual(await fs.readFile(localConfigPath()), before);
      assert.deepEqual(
        (await fs.readdir(agentDir)).filter((name) => name.startsWith(".pi-sync.json.")),
        [],
      );
    } finally {
      open.mockRestore();
    }
    await updateLocalConfig((settings) => ({ ...settings, debug: true }));
    assert.equal((await readLocalConfigObject())?.debug, true);
  });
});

test("a post-publication source read failure restores the validated prior bytes", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    await fs.writeFile(localConfigPath(), before, { mode: 0o600 });
    const original = fs.open.bind(fs);
    let canonicalReads = 0;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (args[0] === localConfigPath() && args[1] === "r" && ++canonicalReads === 2) {
        vi.spyOn(handle, "readFile").mockRejectedValue(new Error("injected source read failure"));
      }
      return handle;
    });
    try {
      await assert.rejects(
        updateLocalConfig((settings) => ({ ...settings, debug: true })),
        /injected source read failure/u,
      );
      assert.deepEqual(await fs.readFile(localConfigPath()), before);
    } finally {
      open.mockRestore();
    }
    await updateLocalConfig((settings) => ({ ...settings, debug: true }));
    assert.equal((await readLocalConfigObject())?.debug, true);
  });
});

for (const editKind of ["in-place", "replacement"] as const) {
  test(`replacement rejects a noncooperating ${editKind} edit before publication`, async () => {
    await withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const before = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "before" }))}\n`);
      const concurrent = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "concurrent" }))}\n`);
      await fs.writeFile(localConfigPath(), before, { mode: 0o600 });
      await assert.rejects(
        withConfigPublicationReadyHookForTest(
          async () => {
            if (editKind === "in-place") await fs.writeFile(localConfigPath(), concurrent, { mode: 0o600 });
            else {
              const external = path.join(agentDir, "external.json");
              await fs.writeFile(external, concurrent, { mode: 0o600 });
              await fs.rename(external, localConfigPath());
            }
          },
          () => updateLocalConfig((settings) => ({ ...settings, debug: true })),
        ),
        /settings changed during migration/u,
      );
      assert.deepEqual(await fs.readFile(localConfigPath()), concurrent);
      const backups = (await fs.readdir(agentDir)).filter((name) => name.endsWith(".schema-migration-source"));
      assert.equal(backups.length, 1);
      assert.deepEqual(await fs.readFile(path.join(agentDir, backups[0] as string)), before);
    });
  });

  test(`post-publication failure never restores over a noncooperating ${editKind} edit`, async () => {
    await withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const before = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "before" }))}\n`);
      const concurrent = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "concurrent" }))}\n`);
      await fs.writeFile(localConfigPath(), before, { mode: 0o600 });
      await assert.rejects(
        withConfigReplacementInstalledHookForTest(
          async () => {
            if (editKind === "in-place") await fs.writeFile(localConfigPath(), concurrent, { mode: 0o600 });
            else {
              const external = path.join(agentDir, "external.json");
              await fs.writeFile(external, concurrent, { mode: 0o600 });
              await fs.rename(external, localConfigPath());
            }
            throw new Error("injected post-publication failure");
          },
          () => updateLocalConfig((settings) => ({ ...settings, debug: true })),
        ),
        /injected post-publication failure/u,
      );
      assert.deepEqual(await fs.readFile(localConfigPath()), concurrent);
      const backups = (await fs.readdir(agentDir)).filter((name) => name.endsWith(".schema-migration-source"));
      assert.equal(backups.length, 1);
      assert.deepEqual(await fs.readFile(path.join(agentDir, backups[0] as string)), before);
    });
  });
}

test("replacement detects writes through the old inode and atomically restores the external edit", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "before" }))}\n`);
    const concurrent = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "concurrent-open-handle" }))}\n`);
    await fs.writeFile(localConfigPath(), before, { mode: 0o600 });
    const external = await fs.open(localConfigPath(), "r+");
    try {
      await assert.rejects(
        withConfigReplacementInstalledHookForTest(
          async () => {
            await external.truncate(0);
            await external.writeFile(concurrent);
            await external.sync();
          },
          () => updateLocalConfig((settings) => ({ ...settings, debug: true })),
        ),
        /settings changed during migration/u,
      );
      assert.deepEqual(await fs.readFile(localConfigPath()), concurrent);
      assert.deepEqual(
        (await fs.readdir(agentDir)).filter((name) => name.startsWith(".pi-sync.json.")),
        [],
      );
      if (process.platform !== "win32") assert.equal((await fs.stat(localConfigPath())).mode & 0o777, 0o600);
    } finally {
      await external.close();
    }
  });
});
