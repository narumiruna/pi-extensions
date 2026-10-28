#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

assert.notEqual(process.platform, "win32", "This benchmark requires POSIX PATH-based browser-launch suppression");
const [kind = "package", ...extra] = process.argv.slice(2);
assert(
  ["source", "package"].includes(kind) && extra.length === 0,
  "Expected source or package, with no trailing arguments",
);
const entry = resolve(fileURLToPath(new URL(kind === "source" ? "../src/index.ts" : "../", import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "pi-inspect-first-use-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousPath = process.env.PATH;
process.env.PI_CODING_AGENT_DIR = directory;
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
  // Supply only the read-only host actions used by the model-free viewer.
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.getActiveTools = () => [];
  let url;
  context = {
    cwd: directory,
    mode: "tui",
    hasUI: true,
    sessionManager: SessionManager.inMemory(directory),
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: directory, skills: [] }),
    ui: {
      confirm: async () => true,
      notify: (message) => {
        url = message.match(/http:\/\/127\.0\.0\.1:[^\s]+/u)?.[0] ?? url;
      },
    },
  };
  await emit("session_start");
  // Never launch a desktop browser; consent is synthetic and assets are read over loopback.
  process.env.PATH = join(directory, "no-executables");
  const startedAt = performance.now();
  await extension.commands.get("inspect").handler("", context);
  assert.ok(url, "Viewer did not open");
  const origin = new URL(url).origin;
  for (const route of ["/", "/app.js", "/app.css"]) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200);
    assert((await response.text()).length > 0);
  }
  const firstUseMs = performance.now() - startedAt;
  await extension.commands.get("inspect").handler("stop", context);
  console.log(JSON.stringify({ entry, name: "inspect", kind, firstUseMs }));
} finally {
  try {
    if (extension && context) await emit("session_shutdown");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}
