import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DefaultResourceLoader, loadSkillsFromDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const run = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryDirectory = resolve(packageDirectory, "../..");
const skillsDirectory = join(packageDirectory, "skills");
const skillDirectory = join(skillsDirectory, "pi-herdr");
const helperPath = join(skillDirectory, "scripts/spawn-peer.mjs");

async function discoverPackageSkills(source: string, root: string) {
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [source] }),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getExtensions().extensions, []);
  const loaded = loader.getSkills();
  assert.deepEqual(loaded.diagnostics, []);
  const peers = loaded.skills.filter(({ name }) => name === "pi-herdr");
  assert.equal(peers.length, 1, "Pi must discover exactly one pi-herdr skill");
  assert.equal(
    loaded.skills.some(({ name }) => name === "herdr" || name === "hc"),
    false,
  );
  const peer = peers[0];
  assert.ok(peer);
  assert.equal(peer.disableModelInvocation, false);
  return peer;
}

async function collectFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await collectFiles(path)));
    else {
      assert.ok(entry.isFile(), `skill resources must be regular files: ${path}`);
      paths.push(path);
    }
  }
  return paths.sort();
}

test("the package retains one extension and publishes one focused Pi peer skill", async () => {
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi, { extensions: ["./dist/index.ts"], skills: ["./skills"] });
  assert.ok(manifest.files.includes("skills"));
  assert.ok(manifest.files.includes("dist"));
  assert.ok(manifest.files.includes("CHANGELOG.md"));
  assert.equal(existsSync(join(skillsDirectory, "herdr")), false);
  assert.equal(existsSync(join(skillsDirectory, "hc")), false);

  const loaded = loadSkillsFromDir({ dir: skillsDirectory, source: "pi-herdr-package-test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(
    loaded.skills.map(({ name }) => name),
    ["pi-herdr"],
  );
  assert.match(loaded.skills[0]?.description ?? "", /independent parallel work/u);
  assert.match(loaded.skills[0]?.description ?? "", /Herdr-managed pane/u);
  assert.equal(loaded.skills[0]?.disableModelInvocation, false);
});

test("Pi's resource loader discovers the package skill without loading the extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-package-resources-"));
  try {
    const skill = await discoverPackageSkills(packageDirectory, root);
    assert.equal(skill.filePath, join(skillDirectory, "SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["source", "package"])(
  "peer loadout preserves other extensions and claims one Herdr runtime with configured %s discovery",
  async (configured) => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-peer-loadout-"));
    const previous = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
      HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    };
    try {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_PANE_ID = "fixture-pane";
      process.env.HERDR_SOCKET_PATH = join(root, "unused.sock");
      const other = join(root, "other.ts");
      await writeFile(
        other,
        'export default function(pi) { pi.registerCommand("unrelated-fixture", { description: "Fixture", handler: async () => {} }); }\n',
      );
      const source = join(packageDirectory, "src/index.ts");
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: join(root, "agent"),
        settingsManager: SettingsManager.inMemory(
          configured === "source"
            ? { extensions: [source, other] }
            : { packages: [packageDirectory], extensions: [other] },
        ),
        additionalExtensionPaths: [configured === "source" ? packageDirectory : source],
        additionalSkillPaths: [skillDirectory],
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.filter((extension) => extension.commands.has("herdr")).length, 1);
      assert.equal(loaded.extensions.filter((extension) => extension.handlers.has("session_start")).length, 1);
      assert.equal(loaded.extensions.filter((extension) => extension.commands.has("unrelated-fixture")).length, 1);
      assert.deepEqual(loader.getSkills().diagnostics, []);
      assert.deepEqual(
        loader
          .getSkills()
          .skills.filter((skill) => skill.name === "pi-herdr")
          .map((skill) => skill.name),
        ["pi-herdr"],
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("the repository registers and discovers pi-herdr without restoring generic skills", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryDirectory, "package.json"), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./packages/pi-herdr/src/index.ts"));
  assert.equal(manifest.pi.skills.filter((path: string) => path === "./packages/pi-herdr/skills").length, 1);

  const root = await mkdtemp(join(tmpdir(), "pi-herdr-repository-resources-"));
  try {
    const skill = await discoverPackageSkills(repositoryDirectory, root);
    assert.equal(skill.filePath, join(skillDirectory, "SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the skill links its spawn helper and keeps relative script imports self-contained", async () => {
  const skill = await readFile(join(skillDirectory, "SKILL.md"), "utf8");
  assert.ok(skill.includes("[spawn helper](scripts/spawn-peer.mjs)"));
  assert.ok(skill.includes('node "$skill_dir/scripts/spawn-peer.mjs" --name reviewer --task-file /absolute/task.txt'));
  const readme = await readFile(join(packageDirectory, "README.md"), "utf8");
  assert.ok(readme.includes("./skills/pi-herdr/SKILL.md"));
  assert.ok(readme.includes("./skills/pi-herdr/scripts/spawn-peer.mjs"));

  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (visited.has(path)) return;
    const local = relative(skillDirectory, path);
    assert.ok(local !== ".." && !local.startsWith("../") && !local.startsWith("..\\") && !isAbsolute(local));
    visited.add(path);
    const source = await readFile(path, "utf8");
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/gu);
    for (const match of imports) {
      assert.ok(match[1]);
      await visit(resolve(dirname(path), match[1]));
    }
  }
  await visit(helperPath);
  const files = await collectFiles(skillDirectory);
  for (const path of files.filter((path) => path.endsWith(".mjs"))) {
    assert.ok(visited.has(path), `unlinked helper resource: ${path}`);
  }
});

test("the extracted npm package preserves the skill, its resources, and Pi discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-packed-resources-"));
  try {
    // Inspect existing output only: do not rebuild shared directories during consumer tests.
    const packed = await run(
      "npm",
      ["pack", packageDirectory, "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: repositoryDirectory, timeout: 3_000, maxBuffer: 1024 * 1024 },
    );
    const records = JSON.parse(packed.stdout) as Array<{
      name: string;
      filename: string;
      files: Array<{ path: string }>;
    }>;
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    assert.equal(record.name, "@narumitw/pi-herdr");
    const files = await collectFiles(skillDirectory);
    const published = new Set(record.files.map(({ path }) => path));
    for (const path of files) {
      assert.ok(published.has(relative(packageDirectory, path).replaceAll("\\", "/")), `missing from tarball: ${path}`);
    }
    await run("tar", ["-xzf", join(root, record.filename), "-C", root], { timeout: 1_000 });
    const extracted = join(root, "package");
    for (const path of files) {
      assert.deepEqual(await readFile(join(extracted, relative(packageDirectory, path))), await readFile(path));
    }
    const skill = await discoverPackageSkills(extracted, root);
    assert.equal(skill.filePath, join(extracted, "skills/pi-herdr/SKILL.md"));
    const helper = join(skill.baseDir, "scripts/spawn-peer.mjs");
    assert.ok(existsSync(helper));
    const help = await run(process.execPath, [helper, "--help"], { timeout: 1_000, maxBuffer: 4096 });
    assert.match(JSON.parse(help.stdout).usage, /--name NAME --task-file PATH/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
