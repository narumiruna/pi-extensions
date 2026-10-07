import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(packageDirectory, "skills/pi-web-search-setup/SKILL.md");
const document = readFileSync(skillPath, "utf8");

test("setup skill is bundled, discoverable, and excluded from automatic model selection", async () => {
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("skills"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  const loaded = loadSkillsFromDir({ dir: path.join(packageDirectory, "skills"), source: "test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0]?.name, "pi-web-search-setup");
  assert.equal(loaded.skills[0]?.disableModelInvocation, true);
  assert.equal(formatSkillsForPrompt(loaded.skills), "");

  const directory = mkdtempSync(path.join(tmpdir(), "web-search-skill-loader-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory({ packages: [packageDirectory] }),
      noExtensions: true,
      noContextFiles: true,
    });
    await loader.reload();
    const resources = loader.getSkills();
    assert.deepEqual(resources.diagnostics, []);
    assert.ok(resources.skills.some((skill) => skill.name === "pi-web-search-setup" && skill.disableModelInvocation));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runExample(directory: string, patch: Record<string, unknown>) {
  const example = /```js\n([\s\S]*?)\n```/u.exec(document)?.[1];
  assert.ok(example);
  const script = example
    .replace(
      "file:///ABSOLUTE_PACKAGE_PATH/src/settings.ts",
      pathToFileURL(path.join(packageDirectory, "src/settings.ts")).href,
    )
    .replace("const patch = {};", `const patch = ${JSON.stringify(patch)};`);
  return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: directory },
  });
}

test("skill example preserves token and unknown fields without exposing them", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-search-skill-edit-"));
  const destination = path.join(directory, "pi-web-search.json");
  const original = { apiToken: "private-token-value", limit: 5, future: "private-unknown-value" };
  try {
    writeFileSync(destination, JSON.stringify(original), { mode: 0o600 });
    const result = runExample(directory, { limit: 3, exposure: "direct" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), { ...original, limit: 3, exposure: "direct" });
    assert.equal(JSON.parse(result.stdout).apiTokenPresent, true);
    assert.doesNotMatch(result.stdout + result.stderr, /private-token-value|private-unknown-value/u);
    if (process.platform !== "win32") assert.equal(statSync(destination).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Give each child process its own test budget instead of accumulating startup costs.
for (const { name, patch } of [
  { name: "credential replacement", patch: { apiToken: "replacement" } },
  { name: "invalid preference", patch: { limit: 99 } },
]) {
  test(`skill example rejects ${name} without modifying or exposing settings`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "web-search-skill-reject-"));
    const destination = path.join(directory, "pi-web-search.json");
    const saved = JSON.stringify({ apiToken: "private-token-value", limit: 3, future: "private-unknown-value" });
    try {
      writeFileSync(destination, saved, { mode: 0o600 });
      const rejected = runExample(directory, patch);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(readFileSync(destination, "utf8"), saved);
      assert.doesNotMatch(rejected.stdout + rejected.stderr, /replacement|private-token-value|private-unknown-value/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("inspection does not create missing settings", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-search-skill-read-"));
  const destination = path.join(directory, "pi-web-search.json");
  try {
    const inspection = runExample(directory, {});
    assert.equal(inspection.status, 0, inspection.stderr);
    assert.equal(JSON.parse(inspection.stdout).saved, false);
    assert.throws(() => statSync(destination), { code: "ENOENT" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed files block edits without exposing parser excerpts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-search-skill-malformed-"));
  const destination = path.join(directory, "pi-web-search.json");
  try {
    const malformed = '{"apiToken":"private-parser-excerpt",';
    writeFileSync(destination, malformed, { mode: 0o600 });
    const result = runExample(directory, { limit: 3 });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(destination, "utf8"), malformed);
    assert.doesNotMatch(result.stdout + result.stderr, /private-parser-excerpt/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
