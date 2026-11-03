import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

interface PackageManifest {
  name: string;
  pi?: { extensions?: string[] };
}

interface PackedPackage {
  name: string;
  files: Array<{ path: string; size: number }>;
}

const activeExtensions = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const directory = join("packages", entry.name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
    return manifest.pi?.extensions === undefined ? [] : [{ directory, name: manifest.name }];
  });

for (const { directory, name } of activeExtensions) {
  test(`${name} publishes its package-root changelog`, () => {
    const npmCli = process.env.npm_execpath;
    const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const args = ["pack", "--workspace", name, "--dry-run", "--ignore-scripts", "--json"];
    // Inspect completed builds without prepack rebuilding shared dependencies during consumer tests.
    const result = spawnSync(command, npmCli ? [npmCli, ...args] : args, { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const packages = JSON.parse(result.stdout) as PackedPackage[];
    assert.equal(packages.length, 1);
    const packed = packages[0];
    assert.ok(packed);
    assert.equal(packed.name, name);
    const changelog = packed.files.find((file) => file.path === "CHANGELOG.md");
    assert.ok(changelog, `${name} must publish CHANGELOG.md`);
    assert.equal(changelog.size, statSync(join(directory, "CHANGELOG.md")).size);
  });
}
