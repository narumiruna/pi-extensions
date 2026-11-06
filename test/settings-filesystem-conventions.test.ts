import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { settingsFilePath as caffeinateSettingsPath } from "../packages/pi-caffeinate/src/settings.js";
import { langfuseConfigPath } from "../packages/pi-langfuse/src/config.js";
import {
  createLocalConfigDocument,
  localConfigPath,
  withConfigPublicationReadyHookForTest,
} from "../packages/pi-sync/src/settings/config-file.js";
import { localConfigTemplate } from "../packages/pi-sync/src/settings/settings-store.js";
import { withTempHome } from "../packages/pi-sync/test/helpers.js";

const SETTINGS_PUBLICATION_SOURCES = [
  "packages/pi-accounts/src/account-store.ts",
  "packages/pi-caffeinate/src/settings.ts",
  "packages/pi-lsp/src/adapters.ts",
  "packages/pi-plan-mode/src/settings.ts",
  "packages/pi-starship/src/config.ts",
  "packages/pi-statusline/src/settings.ts",
  "packages/pi-sync/src/settings/config-file.ts",
] as const;

test("settings publishers do not use hard links or direct canonical copies", () => {
  for (const file of SETTINGS_PUBLICATION_SOURCES) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\blinkSync\b|\b(?:fs\.)?link\s*\(/u, file);
    assert.doesNotMatch(source, /\bcopyFile(?:Sync)?\s*\(/u, file);
  }
});

test("pi-sync publishes a complete, durable temporary inode", async () =>
  withTempHome(async (agentDir) => {
    const events: string[] = [];
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".migrate")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          events.push("temporary-synced");
        };
      }
      return handle;
    });
    const settings = localConfigTemplate();
    let contents: unknown;
    let temporary: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      await withConfigPublicationReadyHookForTest(
        async () => {
          events.push("publication-ready");
          const names = await fs.readdir(agentDir);
          const file = names.find((name) => name.endsWith(".migrate"));
          if (file) {
            const path = join(agentDir, file);
            contents = JSON.parse(await fs.readFile(path, "utf8"));
            temporary = await fs.stat(path);
          }
        },
        () => createLocalConfigDocument(settings),
      );
    } finally {
      spy.mockRestore();
    }
    assert.deepEqual(events, ["temporary-synced", "publication-ready"]);
    assert.deepEqual(contents, settings);
    assert.ok(temporary);
    const installed = await fs.stat(localConfigPath());
    assert.equal(installed.dev, temporary.dev);
    assert.equal(installed.ino, temporary.ino);
    if (process.platform !== "win32") assert.equal(installed.mode & 0o777, 0o600);
  }));

test("settings paths use Pi tilde expansion", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "~/pi-extension-settings-test";
  try {
    const agentDir = join(homedir(), "pi-extension-settings-test");
    assert.equal(caffeinateSettingsPath(), join(agentDir, "pi-caffeinate.json"));
    assert.equal(langfuseConfigPath(), join(agentDir, "pi-langfuse.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
