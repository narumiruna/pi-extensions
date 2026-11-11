import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, loadSkillsFromDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDirectory = path.join(packageDirectory, "skills");
const skillDirectory = path.join(skillsDirectory, "typesafe-ai");
const skillPath = path.join(skillDirectory, "SKILL.md");

function markdownFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const candidate = path.join(directory, entry);
      return statSync(candidate).isDirectory()
        ? markdownFiles(candidate)
        : candidate.endsWith(".md")
          ? [candidate]
          : [];
    })
    .sort();
}

function localMarkdownLinks(file: string): string[] {
  const content = readFileSync(file, "utf8");
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/gu)].flatMap((match) => {
    const target = (match[1] ?? "").split("#", 1)[0] ?? "";
    return /^[a-z]+:/iu.test(target) ? [] : [path.resolve(path.dirname(file), target)];
  });
}

test("package bundles a discoverable TypeSafe skill", () => {
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
    files: string[];
    pi: { extensions: string[]; skills?: string[] };
  };
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.files.includes("skills"));

  const result = loadSkillsFromDir({ dir: skillsDirectory, source: "pi-typesafe-test" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  const skill = result.skills[0];
  assert.equal(skill?.name, "typesafe-ai");
  assert.match(skill?.description ?? "", /TypeSafe and Jev/u);
  assert.match(skill?.description ?? "", /typesafe_question/u);
  assert.match(skill?.description ?? "", /routing, ranking, extraction, verification, scoring/u);
});

test("Pi discovers the skill from the package", async () => {
  const agentDirectory = mkdtempSync(path.join(tmpdir(), "pi-typesafe-package-skill-"));
  const previousHome = process.env.HOME;
  process.env.HOME = agentDirectory;
  try {
    const loader = new DefaultResourceLoader({
      cwd: agentDirectory,
      agentDir: agentDirectory,
      settingsManager: SettingsManager.inMemory({ packages: [packageDirectory] }),
      noExtensions: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getSkills();
    assert.deepEqual(loaded.diagnostics, []);
    assert.ok(loaded.skills.some(({ name }) => name === "typesafe-ai"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(agentDirectory, { force: true, recursive: true });
  }
});

test("every bundled TypeSafe reference is valid and reachable from the skill", () => {
  const files = [skillPath, ...markdownFiles(path.join(skillDirectory, "references"))];
  const expected = new Set(files.map((file) => path.resolve(file)));
  const visited = new Set<string>();
  const queue = [path.resolve(skillPath)];

  while (queue.length > 0) {
    const file = queue.shift();
    assert.ok(file);
    if (visited.has(file)) continue;
    visited.add(file);

    for (const target of localMarkdownLinks(file)) {
      assert.ok(target.startsWith(`${skillDirectory}${path.sep}`), `${file} links outside the skill: ${target}`);
      assert.equal(existsSync(target), true, `${file} links to missing reference: ${target}`);
      if (!visited.has(target)) queue.push(target);
    }
  }

  assert.deepEqual([...visited].sort(), [...expected].sort());

  const readme = readFileSync(path.join(packageDirectory, "README.md"), "utf8");
  assert.match(readme, /skills\/typesafe-ai\/references\/index\.md/u);
});
