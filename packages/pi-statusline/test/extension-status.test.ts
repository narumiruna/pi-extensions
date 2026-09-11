import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  buildExtensionStatusIconAliases,
  findDuplicateExtensions,
  readInstalledExtensionPackages,
} from "../src/extension-status.js";

test("installed package discovery uses the configured Pi agent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-statusline-agent-dir-"));
  const agentDir = join(root, "configured-agent");
  const homeDir = join(root, "unrelated-home");
  const homeAgentDir = join(homeDir, ".pi", "agent");
  const projectDir = join(root, "project");
  const projectSettingsDir = join(projectDir, ".pi");
  const localExtensionDir = join(projectDir, "local-foo");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(homeAgentDir, { recursive: true });
  mkdirSync(projectSettingsDir, { recursive: true });
  mkdirSync(localExtensionDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@test/pi-foo@1.0.0"] }));
  writeFileSync(join(homeAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:@test/pi-home-only@1.0.0"] }));
  writeFileSync(
    join(projectSettingsDir, "settings.json"),
    JSON.stringify({ packages: ["../local-foo", "npm:@test/pi-project@1.0.0"] }),
  );
  writeFileSync(join(localExtensionDir, "package.json"), JSON.stringify({ name: "@test/pi-foo" }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = homeDir;

  try {
    const installedPackages = readInstalledExtensionPackages(projectDir);

    assert.deepEqual(
      installedPackages.map(({ packageName, source }) => ({ packageName, source })),
      [
        { packageName: "@test/pi-foo", source: "npm:@test/pi-foo@1.0.0" },
        { packageName: "@test/pi-foo", source: "../local-foo" },
        { packageName: "@test/pi-project", source: "npm:@test/pi-project@1.0.0" },
      ],
    );
    assert.deepEqual(findDuplicateExtensions(installedPackages), ["foo"]);
    const aliases = buildExtensionStatusIconAliases(installedPackages);
    assert.ok(aliases.get("foo")?.includes("npm:@test/pi-foo"));
    assert.equal(aliases.has("home-only"), false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
