import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDirectory = path.resolve(packageDirectory, "../..");
const skillsDirectory = path.join(packageDirectory, "skills");
const skillDirectory = path.join(skillsDirectory, "configure-pi-sync");
const referencePath = path.join(skillDirectory, "references/configuration.md");
const skillText = readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
const reference = readFileSync(referencePath, "utf8");
const readme = readFileSync(path.join(packageDirectory, "README.md"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8"));

function headingId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

function unfencedLines(markdown: string): string[] {
  let fenced = false;
  return markdown.split("\n").filter((line) => {
    if (line.startsWith("```")) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

function headings(markdown: string): string[] {
  return unfencedLines(markdown).flatMap((line) => /^#{2,4} (.+)$/u.exec(line)?.slice(1) ?? []);
}

function explicitAnchors(markdown: string): string[] {
  return unfencedLines(markdown).flatMap((line) =>
    [...line.matchAll(/<a\s+id="([^"]+)"\s*><\/a>/gu)].map((match) => match[1] ?? ""),
  );
}

function fragmentIds(markdown: string): Set<string> {
  return new Set([...headings(markdown).map(headingId), ...explicitAnchors(markdown)]);
}

function configurationExample(): Record<string, unknown> {
  const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/gu)]
    .map((match) => JSON.parse(match[1] ?? "") as Record<string, unknown>)
    .filter((example) => Object.hasOwn(example, "storageConnections"));
  assert.equal(examples.length, 1, "keep one authoritative complete example");
  const example = examples[0];
  assert.ok(example);
  return example;
}

test("manifest publishes one model-invocable skill without changing the extension entrypoint", () => {
  assert.deepEqual(manifest.pi.extensions, ["./dist/index.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.files.includes("skills"));
  const loaded = loadSkillsFromDir({ dir: skillsDirectory, source: "pi-sync-test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0]?.name, "configure-pi-sync");
  assert.equal(loaded.skills[0]?.baseDir, skillDirectory);
  assert.equal(loaded.skills[0]?.disableModelInvocation, false);
  for (const phrase of [
    "Explain Pi Sync settings",
    "pi-sync.json",
    ".syncignore",
    "apply authorized routine edits",
    "choose synced paths",
    "troubleshoot local sync errors",
    "Do not use it to run sync",
    "administer remote storage",
    "modify unrelated settings",
  ]) {
    assert.ok(loaded.skills[0]?.description.includes(phrase), `missing trigger boundary: ${phrase}`);
  }
  assert.deepEqual(readdirSync(skillDirectory).sort(), ["SKILL.md", "references"]);
});

for (const source of ["package", "root"] as const) {
  test(`${source} package discovery and reload advertise the skill to the model`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pi-sync-skill-loader-"));
    const previousHome = process.env.HOME;
    process.env.HOME = directory;
    try {
      const packagePath = source === "package" ? packageDirectory : rootDirectory;
      const rootManifest = JSON.parse(readFileSync(path.join(rootDirectory, "package.json"), "utf8"));
      assert.ok(rootManifest.pi.skills.includes("./packages/pi-sync/skills"));
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: SettingsManager.inMemory({ packages: [packagePath] }),
        noExtensions: true,
        noContextFiles: true,
      });
      for (const pass of ["initial", "reload"]) {
        await loader.reload();
        const result = loader.getSkills();
        assert.deepEqual(result.diagnostics, [], pass);
        const skills = result.skills.filter(({ name }) => name === "configure-pi-sync");
        assert.equal(skills.length, 1, pass);
        assert.equal(skills[0]?.disableModelInvocation, false);
        const catalog = formatSkillsForPrompt(skills);
        assert.match(catalog, /<name>configure-pi-sync<\/name>/u, pass);
        assert.match(catalog, /<description>Explain Pi Sync settings/u, pass);
        assert.doesNotMatch(catalog, /Make and verify a clear, authorized local edit/u, pass);
      }
      assert.deepEqual(readdirSync(directory), [], "resource discovery must not materialize user settings");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(directory, { force: true, recursive: true });
    }
  });
}

test("skill separates authorized local changes from read-only troubleshooting and reviewed operations", () => {
  for (const contract of [
    "Invoking this skill or asking a question does not authorize a write",
    "start with read-only local checks",
    "Distinguish an unsupported setup, a retired remote format, a retired local baseline, and a pending recovery error",
    "Do not start or replace the daemon, downgrade packages, remove or rewrite settings",
    "expected: documentFingerprint(document), next",
    "`settings.repair-read` with `{}` for a non-migrating read",
    "verify the requested fields before reporting success",
    "proceed only if it returns an owner with `needsUpgrade: false`",
    "A schema-valid change is not proof of user review or consent, even in a legacy-only setup",
    "Keep settings, daemon payloads, and other private evidence in the local process",
    "use `pi_sync_debug` with `latest` if the tool is available",
    "without contacting the daemon",
    "never raw log lines",
    "use `pi_sync_debug` with `recheck` only when available",
    "If it is unavailable or the user declines, do not use another tool to make the read",
    "do not enable Debug mode or start a transfer just to collect evidence",
    "Leave operations that Pi Sync requires the user to review in `/sync`",
    "Do not start sync, run backend/network commands",
    "Leave any WebDAV history repair to the user in **/sync → History**",
  ]) {
    assert.ok(skillText.includes(contract), `missing skill contract: ${contract}`);
  }
  assert.match(reference, /Agent directory changed or has an unsafe filesystem layout/u);
  assert.match(reference, /this error alone does not identify a path or field/u);
  assert.match(reference, /Repair active snapshot history.*isolated conditional-write probe and cleans it up/u);
  assert.doesNotMatch(skillText, /\/sync (doctor|status)/u);
  assert.doesNotMatch(reference, /\/sync (doctor|status)/u);
});

test("documentation fragments accept headings and explicit anchors outside fenced code", () => {
  const markdown = [
    "### Visible heading",
    '<a id="legacy-fragment"></a>',
    "```html",
    '<a id="code-only"></a>',
    "### Code heading",
    "```",
  ].join("\n");
  assert.deepEqual([...fragmentIds(markdown)], ["visible-heading", "legacy-fragment"]);
});

test("bundled links stay inside the skill and identify existing reference fragments", () => {
  const documents = [path.join(skillDirectory, "SKILL.md"), referencePath];
  for (const document of documents) {
    const text = readFileSync(document, "utf8");
    for (const match of text.matchAll(/\]\(([^)]+)\)/gu)) {
      const target = match[1] ?? "";
      if (/^https:\/\//u.test(target)) continue;
      const [file = "", anchor] = target.split("#");
      const resolved = file ? path.resolve(path.dirname(document), file) : document;
      assert.ok(resolved.startsWith(`${skillDirectory}${path.sep}`), `reference escapes skill: ${target}`);
      const destination = readFileSync(resolved, "utf8");
      if (anchor) assert.ok(fragmentIds(destination).has(anchor), target);
    }
  }
  assert.match(reference, /authoritative public settings reference/u);
  assert.match(readme, /automatically load/u);
  assert.match(readme, /Loading the skill does not authorize edits/u);
  assert.match(readme, /applies authorized edits to `pi-sync\.json` through the running local daemon/u);
  assert.match(readme, /\/skill:configure-pi-sync/u);
  assert.match(readme, /skills\/configure-pi-sync\/references\/configuration\.md/u);
  assert.doesNotMatch(readme, /\.\/docs\/settings\.md/u);
});

test("moved operational links still name existing repository files and fragments", () => {
  const prefix = "https://github.com/narumiruna/pi-extensions/blob/main/";
  for (const match of reference.matchAll(/\]\((https:[^)]+)\)/gu)) {
    const target = match[1] ?? "";
    assert.ok(target.startsWith(prefix), `unexpected external reference: ${target}`);
    const [file = "", anchor] = target.slice(prefix.length).split("#");
    const destination = readFileSync(path.join(rootDirectory, file), "utf8");
    if (anchor) assert.ok(fragmentIds(destination).has(anchor), target);
  }
});

test("operational verification links point directly to authoritative settings fragments", () => {
  for (const [file, fragment] of [
    ["agent-mode-verification.md", "autonomous-sync"],
    ["agent-quality-verification.md", "autonomous-sync"],
    ["continuous-sync-verification.md", "continuous-sync"],
  ] as const) {
    const document = readFileSync(path.join(packageDirectory, "docs", file), "utf8");
    const target = `../skills/configure-pi-sync/references/configuration.md#${fragment}`;
    assert.ok(document.includes(`](${target})`), `${file}: ${target}`);
    assert.ok(fragmentIds(reference).has(fragment), target);
  }
});

test("the authoritative settings reference retains original fragments and current headings", () => {
  const originalHeadings = [
    "⚙️ Settings",
    "Editing in the manager",
    "Complete version 3 example",
    "Required backend shapes",
    "Status display",
    "Debug mode",
    "Secret scanning",
    "Diagnostics",
    "Retired ignore-file policy",
    "Included content",
    "Automatic startup transfer",
    "Unchanged transfer fast path",
    "Experimental Agent mode",
    "Experimental Continuous sync",
    "Activation and ownership",
    "Detection, retries and safety blocks",
    "Request limits and private records",
    "Status, recovery and downgrade",
    "Settings field merge and machine-local fields",
    "Content merge and partial progress",
    "Unsupported old settings and recovery",
  ];
  const renamedHeadings = new Map([
    ["Experimental Agent mode", "Autonomous sync"],
    ["Experimental Continuous sync", "Continuous sync"],
  ]);
  for (const heading of originalHeadings) {
    const currentHeading = renamedHeadings.get(heading) ?? heading;
    assert.ok(headings(reference).includes(currentHeading), currentHeading);
    assert.ok(fragmentIds(reference).has(headingId(heading)), `missing reference URL: ${heading}`);
  }
});

test("all settings documents expose current headings and invisible legacy fragment anchors", () => {
  for (const [label, document] of [
    ["README", readme],
    ["authoritative reference", reference],
  ] as const) {
    for (const [heading, legacyFragment] of [
      ["Autonomous sync", "experimental-agent-mode"],
      ["Continuous sync", "experimental-continuous-sync"],
    ] as const) {
      assert.ok(headings(document).includes(heading), `${label}: ${heading}`);
      assert.ok(fragmentIds(document).has(headingId(heading)), `${label}: current fragment`);
      assert.equal(explicitAnchors(document).filter((anchor) => anchor === legacyFragment).length, 1, label);
      assert.ok(fragmentIds(document).has(legacyFragment), `${label}: ${legacyFragment}`);
    }
    const visibleText = document.replace(/<a\s+id="[^"]+"\s*><\/a>/gu, "");
    assert.doesNotMatch(
      visibleText,
      /experimental\s+(?:agent[ -]mode|autonomous sync|continuous sync)|\bagent[ -]mode\b/iu,
      label,
    );
    assert.doesNotMatch(document, /\]\([^)\n]*#experimental-(?:agent-mode|continuous-sync)\)/u, label);
  }
  assert.match(skillText, /\*\*Autonomous sync\*\*/u);
  assert.match(skillText, /\*\*Continuous sync\*\*/u);
  assert.doesNotMatch(skillText, /experimental|agent[ -]mode/iu);
});

test("the published example validates Git, WebDAV, and R2/S3 with required per-setup policy", () => {
  const example = configurationExample();
  const settings = validateSettingsDocument(example);
  assert.deepEqual(
    Object.values(settings.storageConnections)
      .map(({ type }) => type)
      .sort(),
    ["git", "s3", "webdav"],
  );
  for (const setup of Object.values(settings.syncSetups)) {
    assert.ok(Array.isArray(setup.sync.include));
    assert.equal(typeof setup.sync.automatic, "boolean");
    assert.ok(setup.storage.path);
  }
  assert.equal(example.version, 3);
});

for (const [version, policy] of [
  [4, { localFields: [] }],
  [4, { localFields: ["shellPath"] }],
  [5, { localFields: ["shellPath"], mergeContent: true, partialSync: true }],
  [6, { exclude: ["skills/private"] }],
] as const) {
  test(`documented version ${version} accepts ${JSON.stringify(policy)} without accepting a downgrade`, () => {
    const settings = validateSettingsDocument(configurationExample());
    settings.version = version;
    assert.ok(settings.syncSetups.home);
    Object.assign(settings.syncSetups.home.sync, policy);
    validateSettingsDocument(settings);
    settings.version = version === 5 ? 4 : 3;
    assert.throws(() => validateSettingsDocument(settings), /requires explicit settings version/u);
  });
}

function documentedPolicyFragments() {
  return [...reference.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(
    (match) => JSON.parse(match[1] ?? "") as Record<string, unknown>,
  );
}

test("the exclusion policy fragment validates inside a version-6 allowlist setup", () => {
  const fragments = documentedPolicyFragments().filter(
    (value) => value.scope === undefined && Object.hasOwn(value, "exclude"),
  );
  assert.equal(fragments.length, 1);
  const settings = validateSettingsDocument(configurationExample());
  settings.version = 6;
  const setup = settings.syncSetups.home;
  assert.ok(setup);
  Object.assign(setup.sync, fragments[0]);
  validateSettingsDocument(settings);
});

test("the directory policy fragment validates inside a version-7 setup without include", () => {
  const fragments = documentedPolicyFragments().filter(
    (value) => value.scope === "agent-directory" && value.pathPolicy === undefined,
  );
  assert.equal(fragments.length, 1);
  const settings = validateSettingsDocument(configurationExample());
  settings.version = 7;
  const setup = settings.syncSetups.home;
  assert.ok(setup);
  Object.assign(setup, { sync: fragments[0] });
  validateSettingsDocument(settings);
});
