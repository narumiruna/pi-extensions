import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceScripts = path.join(packageDirectory, "skills/configure-pi-starship/scripts");
const hostPackage = "@earendil-works/pi-coding-agent";
const hostEntry = import.meta.resolve(hostPackage);
const kitDirectory = fileURLToPath(new URL("..", import.meta.resolve("@narumitw/pi-tui-kit")));

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-separated-host-"));
  const managedModules = path.join(directory, "managed/node_modules");
  const scripts = path.join(managedModules, "@narumitw/pi-starship/skills/configure-pi-starship/scripts");
  const bin = path.join(directory, ".bun/bin");
  const globalHost = path.join(directory, ".bun/install/global/node_modules", hostPackage);
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of ["config-path.mjs", "script-support.mjs"]) {
    copyFileSync(path.join(sourceScripts, name), path.join(scripts, name));
  }
  symlinkSync(kitDirectory, path.join(managedModules, "@narumitw/pi-tui-kit"), "junction");
  installHost(globalHost);
  const cli = path.join(globalHost, "dist/bundle/cli.js");
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, '#!/usr/bin/env node\nthrow new Error("The resolver must not execute the Pi CLI.");\n', {
    mode: 0o755,
  });
  symlinkSync(cli, path.join(bin, "pi"), "file");
  return {
    directory,
    bin,
    globalHost,
    localHost: path.join(managedModules, hostPackage),
    run(agentDir: string | undefined = undefined, searchPath = bin, args: string[] = []) {
      return spawnSync(process.execPath, [path.join(scripts, "config-path.mjs"), ...args], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, PATH: searchPath, PI_CODING_AGENT_DIR: agentDir },
      });
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function installHost(directory: string, source = `export { getAgentDir } from ${JSON.stringify(hostEntry)};`) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: hostPackage, type: "module", exports: { ".": { import: "./public-api.mjs" } } }),
  );
  writeFileSync(path.join(directory, "public-api.mjs"), source);
}

for (const [name, configured, expected] of [
  ["default", undefined, () => path.join(homedir(), ".pi/agent/pi-starship.toml")],
  ["empty override", "", () => path.join(homedir(), ".pi/agent/pi-starship.toml")],
  ["home", "~", () => path.join(homedir(), "pi-starship.toml")],
  [
    "home with spaces and Unicode",
    "~/Pi settings/中文",
    () => path.join(homedir(), "Pi settings/中文/pi-starship.toml"),
  ],
  ["relative override", ".pi/custom agent", (cwd: string) => path.join(cwd, ".pi/custom agent/pi-starship.toml")],
  ["absolute override", path.join(tmpdir(), "Pi settings"), () => path.join(tmpdir(), "Pi settings/pi-starship.toml")],
] as const) {
  test(`config resolver uses Pi's public API for a Bun-global host: ${name}`, () => {
    const state = fixture();
    try {
      const before = readdirSync(state.directory, { recursive: true });
      const result = state.run(configured);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(JSON.parse(result.stdout), expected(state.directory));
      assert.deepEqual(readdirSync(state.directory, { recursive: true }), before);
    } finally {
      state.dispose();
    }
  });
}

test("config resolver prefers an available local host over PATH", () => {
  const state = fixture();
  try {
    const localAgent = path.join(state.directory, "local-agent");
    installHost(state.localHost, `export function getAgentDir() { return ${JSON.stringify(localAgent)}; }`);
    const result = state.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), path.join(localAgent, "pi-starship.toml"));
  } finally {
    state.dispose();
  }
});

test("config resolver does not mask a local host import failure with another Pi", () => {
  const state = fixture();
  try {
    installHost(state.localHost, 'import "missing-host-dependency-for-resolver-test";');
    const result = state.run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /missing-host-dependency-for-resolver-test/u);
  } finally {
    state.dispose();
  }
});

test("config resolver stops at the first executable Pi instead of choosing a later installation", () => {
  const state = fixture();
  try {
    const firstBin = path.join(state.directory, "first-bin");
    mkdirSync(firstBin);
    writeFileSync(path.join(firstBin, "pi"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const result = state.run(undefined, [firstBin, state.bin].join(path.delimiter));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /first pi executable on PATH/u);
    assert.match(result.stderr, /No settings were changed/u);
  } finally {
    state.dispose();
  }
});

test("config resolver skips non-executable PATH entries and follows a relative symlink", () => {
  const state = fixture();
  try {
    const firstBin = path.join(state.directory, "first-bin");
    const relativeBin = path.join(state.directory, "relative-bin");
    mkdirSync(firstBin);
    mkdirSync(relativeBin);
    writeFileSync(path.join(firstBin, "pi"), "not executable");
    chmodSync(path.join(firstBin, "pi"), 0o644);
    symlinkSync(path.relative(relativeBin, path.join(state.bin, "pi")), path.join(relativeBin, "pi"), "file");
    const agentDir = path.join(state.directory, "agent");
    const result = state.run(agentDir, [firstBin, "relative-bin"].join(path.delimiter));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), path.join(agentDir, "pi-starship.toml"));
  } finally {
    state.dispose();
  }
});

test("config resolver reports an unavailable host without guessing or writing settings", () => {
  const state = fixture();
  try {
    const before = readdirSync(state.directory, { recursive: true });
    const result = state.run(undefined, path.join(state.directory, "missing-bin"));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /no pi executable is available on PATH/u);
    assert.match(result.stderr, /explicit settings path/u);
    assert.deepEqual(readdirSync(state.directory, { recursive: true }), before);
  } finally {
    state.dispose();
  }
});

test("config resolver rejects arguments before attempting host resolution", () => {
  const state = fixture();
  try {
    const result = state.run(undefined, "", ["unexpected"]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: node scripts\/config-path.mjs/u);
    assert.doesNotMatch(result.stderr, /Unable to locate/u);
  } finally {
    state.dispose();
  }
});
