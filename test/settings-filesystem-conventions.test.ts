import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { settingsFilePath as caffeinateSettingsPath } from "../packages/pi-caffeinate/src/settings.js";
import { settingsFilePath as chromeDevtoolsSettingsPath } from "../packages/pi-chrome-devtools/src/settings.js";
import { settingsFilePath as firecrawlSettingsPath } from "../packages/pi-firecrawl/src/settings.js";
import { langfuseConfigPath } from "../packages/pi-langfuse/src/config.js";

const SETTINGS_PUBLICATION_SOURCES = [
  "packages/pi-accounts/src/account-store.ts",
  "packages/pi-caffeinate/src/settings.ts",
  "packages/pi-chrome-devtools/src/settings.ts",
  "packages/pi-firecrawl/src/settings.ts",
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

test("pi-sync publishes a complete, durable temporary inode", () => {
  const source = readFileSync("packages/pi-sync/src/settings/config-file.ts", "utf8");
  assert.doesNotMatch(source, /\bcopyFile\s*\(/u);
  assert.match(source, /await publishedHandle\.sync\(\)/u);
});

test("settings paths use Pi tilde expansion", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "~/pi-extension-settings-test";
  try {
    const agentDir = join(homedir(), "pi-extension-settings-test");
    assert.equal(caffeinateSettingsPath(), join(agentDir, "pi-caffeinate.json"));
    assert.equal(chromeDevtoolsSettingsPath(), join(agentDir, "pi-chrome-devtools.json"));
    assert.equal(firecrawlSettingsPath(), join(agentDir, "pi-firecrawl.json"));
    assert.equal(langfuseConfigPath(), join(agentDir, "pi-langfuse.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
