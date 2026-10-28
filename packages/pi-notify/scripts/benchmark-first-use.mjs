#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";

assert.notEqual(process.platform, "win32", "This first-use benchmark is verified only on POSIX hosts");
const [kind = "package", ...extra] = process.argv.slice(2);
assert(
  ["source", "package"].includes(kind) && extra.length === 0,
  "Expected source or package, with no trailing arguments",
);
const entry = resolve(fileURLToPath(new URL(kind === "source" ? "../src/index.ts" : "../", import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "pi-notify-first-use-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
let harness;
let extension;
let context;
const emit = async (name) => {
  for (const handler of extension.handlers.get(name) ?? []) await handler({}, context);
};
try {
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [entry],
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  extension = loaded.extensions[0];
  harness = createTuiHarness();
  context = {
    cwd: directory,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    sessionManager: SessionManager.inMemory(directory),
    ui: {
      custom: harness.custom,
      notify: () => {},
      onTerminalInput: () => () => {},
    },
  };
  // The isolated agent directory has no notification destinations or user credentials.
  await emit("session_start");
  const startedAt = performance.now();
  const running = extension.commands.get("notify").handler("", context);
  await harness.waitForOpen();
  const firstUseMs = performance.now() - startedAt;
  harness.press("ctrl+c");
  await running;
  console.log(JSON.stringify({ entry, name: "notify", kind, firstUseMs }));
} finally {
  try {
    if (extension && context) await emit("session_shutdown");
  } finally {
    harness?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
}
