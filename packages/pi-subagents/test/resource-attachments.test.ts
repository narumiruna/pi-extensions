import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
  MAX_ATTACHED_EXTENSIONS,
  MAX_ATTACHED_SKILLS,
  MAX_SELECTED_TOOLS,
  MAX_SKILL_IGNORE_BYTES,
  MAX_SKILL_SCAN_BYTES,
  MAX_SKILL_SCAN_DEPTH,
  MAX_SKILL_SCAN_ENTRIES,
  resolveResourceAttachments,
} from "../src/resource-attachments.js";

let root: string;
let project: string;
let external: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-resources-"));
  project = path.join(root, "project");
  external = path.join(root, "external");
  mkdirSync(project);
  mkdirSync(external);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("canonicalizes, deduplicates, and merges explicit local attachments", async () => {
  const skill = path.join(project, "skills", "review");
  const extension = path.join(project, "extensions", "search.ts");
  mkdirSync(skill, { recursive: true });
  mkdirSync(path.dirname(extension), { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: review\ndescription: Review code.\n---\n");
  writeFileSync(extension, "export default () => {};\n");

  const result = await resolveResourceAttachments(
    {
      skills: ["./skills/review", skill],
      extensions: [
        { path: "./extensions/search.ts", tools: ["search_code", "search_code"] },
        { path: extension, tools: ["fetch_issue"] },
      ],
    },
    { cwd: project, projectTrusted: true, coreTools: ["read", "grep"] },
  );

  assert.deepEqual(result, {
    skills: [skill],
    extensions: [{ path: extension, tools: ["search_code", "fetch_issue"] }],
    effectiveTools: ["read", "grep", "search_code", "fetch_issue"],
  });
});

test("accepts only skill paths that Pi loads", async () => {
  const directSkill = path.join(external, "direct.md");
  const disabledSkill = path.join(external, "disabled.md");
  const warningSkill = path.join(external, "warning.md");
  const skillDirectory = path.join(external, "skill-directory");
  const rootMarkdownDirectory = path.join(external, "root-markdown-directory");
  const nestedSkillDirectory = path.join(external, "nested-skill-directory");
  writeFileSync(directSkill, "---\nname: direct\ndescription: Direct skill.\n---\n");
  writeFileSync(
    disabledSkill,
    "---\nname: disabled\ndescription: Explicit-only skill.\ndisable-model-invocation: true\n---\n",
  );
  writeFileSync(warningSkill, "---\nname: Invalid_Name\ndescription: Pi loads this skill with a warning.\n---\n");
  mkdirSync(skillDirectory);
  writeFileSync(path.join(skillDirectory, "SKILL.md"), "---\nname: directory\ndescription: Directory skill.\n---\n");
  mkdirSync(rootMarkdownDirectory);
  writeFileSync(
    path.join(rootMarkdownDirectory, "root.md"),
    "---\nname: root-markdown\ndescription: Root Markdown skill.\n---\n",
  );
  mkdirSync(path.join(nestedSkillDirectory, "nested"), { recursive: true });
  writeFileSync(
    path.join(nestedSkillDirectory, "nested", "SKILL.md"),
    "---\nname: nested\ndescription: Nested skill.\n---\n",
  );

  assert.deepEqual(
    (
      await resolveResourceAttachments(
        {
          skills: [
            directSkill,
            disabledSkill,
            warningSkill,
            skillDirectory,
            rootMarkdownDirectory,
            nestedSkillDirectory,
          ],
        },
        { cwd: project, projectTrusted: true, coreTools: [] },
      )
    ).skills,
    [directSkill, disabledSkill, warningSkill, skillDirectory, rootMarkdownDirectory, nestedSkillDirectory],
  );

  const nonMarkdownFile = path.join(external, "not-a-skill.txt");
  const missingDescription = path.join(external, "missing-description.md");
  const emptyDirectory = path.join(external, "empty-directory");
  const shadowedDirectory = path.join(external, "shadowed-directory");
  const nestedMarkdownDirectory = path.join(external, "nested-markdown-directory");
  const ignoredDirectory = path.join(external, "ignored-directory");
  writeFileSync(nonMarkdownFile, "not a skill\n");
  writeFileSync(missingDescription, "---\nname: missing-description\n---\n");
  mkdirSync(emptyDirectory);
  mkdirSync(path.join(shadowedDirectory, "nested"), { recursive: true });
  writeFileSync(path.join(shadowedDirectory, "SKILL.md"), "---\nname: shadowed\n---\n");
  writeFileSync(
    path.join(shadowedDirectory, "nested", "SKILL.md"),
    "---\nname: hidden-valid\ndescription: Hidden by the root declaration.\n---\n",
  );
  mkdirSync(path.join(nestedMarkdownDirectory, "nested"), { recursive: true });
  writeFileSync(
    path.join(nestedMarkdownDirectory, "nested", "ordinary.md"),
    "---\nname: ignored-nested-markdown\ndescription: Nested ordinary Markdown is ignored.\n---\n",
  );
  mkdirSync(ignoredDirectory);
  writeFileSync(path.join(ignoredDirectory, ".gitignore"), "SKILL.md\n");
  writeFileSync(path.join(ignoredDirectory, "SKILL.md"), "---\nname: ignored\ndescription: Ignored skill.\n---\n");

  for (const skill of [
    nonMarkdownFile,
    missingDescription,
    emptyDirectory,
    shadowedDirectory,
    nestedMarkdownDirectory,
    ignoredDirectory,
  ]) {
    await assert.rejects(
      () => resolveResourceAttachments({ skills: [skill] }, { cwd: project, projectTrusted: true, coreTools: [] }),
      /at least one loadable Pi skill/i,
    );
  }
});

test("rejects invalid declared skills while honoring Pi ignore files", async () => {
  const partialDirectory = path.join(external, "partial-directory");
  mkdirSync(path.join(partialDirectory, "broken"), { recursive: true });
  writeFileSync(path.join(partialDirectory, "valid.md"), "---\nname: valid\ndescription: Valid skill.\n---\n");
  writeFileSync(path.join(partialDirectory, "broken", "SKILL.md"), "---\nname: broken\n---\n");

  await assert.rejects(
    () =>
      resolveResourceAttachments({ skills: [partialDirectory] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /invalid or unreadable declared skill/i,
  );

  const brokenLinkDirectory = path.join(external, "broken-link-directory");
  mkdirSync(path.join(brokenLinkDirectory, "broken"), { recursive: true });
  writeFileSync(path.join(brokenLinkDirectory, "valid.md"), "---\nname: valid-link\ndescription: Valid skill.\n---\n");
  symlinkSync(path.join(brokenLinkDirectory, "missing.md"), path.join(brokenLinkDirectory, "broken", "SKILL.md"));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { skills: [brokenLinkDirectory] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /invalid or unreadable declared skill/i,
  );

  for (const [index, ignoreFilename] of [".gitignore", ".ignore", ".fdignore"].entries()) {
    const ignoredDirectory = path.join(external, `ignored-directory-${index}`);
    const nestedDirectory = path.join(ignoredDirectory, "nested");
    mkdirSync(path.join(nestedDirectory, "ignored"), { recursive: true });
    const ignoreDirectory = index === 0 ? ignoredDirectory : nestedDirectory;
    const ignorePattern = index === 0 ? "nested/ignored/SKILL.md\n" : "ignored/SKILL.md\n";
    writeFileSync(path.join(ignoreDirectory, ignoreFilename), ignorePattern);
    writeFileSync(
      path.join(ignoredDirectory, "valid.md"),
      `---\nname: valid-ignore-${index}\ndescription: Valid skill.\n---\n`,
    );
    writeFileSync(
      path.join(ignoredDirectory, "nested", "ignored", "SKILL.md"),
      `---\nname: ignored-${index}\ndescription: Ignored skill.\n---\n`,
    );
    assert.deepEqual(
      (
        await resolveResourceAttachments(
          { skills: [ignoredDirectory] },
          { cwd: project, projectTrusted: true, coreTools: [] },
        )
      ).skills,
      [ignoredDirectory],
    );
  }
});

test("bounds and cancels skill-directory preflight", async () => {
  const wideDirectory = path.join(external, "wide-directory");
  mkdirSync(wideDirectory);
  for (let index = 0; index <= MAX_SKILL_SCAN_ENTRIES; index++) {
    writeFileSync(path.join(wideDirectory, String(index)), "");
  }
  await assert.rejects(
    () =>
      resolveResourceAttachments({ skills: [wideDirectory] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /skill attachment exceeds traversal limits/i,
  );

  const deepDirectory = path.join(external, "deep-directory");
  let nestedDirectory = deepDirectory;
  mkdirSync(nestedDirectory);
  for (let depth = 0; depth <= MAX_SKILL_SCAN_DEPTH; depth++) {
    nestedDirectory = path.join(nestedDirectory, "nested");
    mkdirSync(nestedDirectory);
  }
  writeFileSync(path.join(nestedDirectory, "SKILL.md"), "---\nname: deep\ndescription: Deep skill.\n---\n");
  await assert.rejects(
    () =>
      resolveResourceAttachments({ skills: [deepDirectory] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /skill attachment exceeds traversal limits/i,
  );

  const oversizedSkill = path.join(external, "oversized.md");
  writeFileSync(oversizedSkill, Buffer.alloc(MAX_SKILL_SCAN_BYTES + 1));
  await assert.rejects(
    () =>
      resolveResourceAttachments({ skills: [oversizedSkill] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /skill attachment exceeds traversal limits/i,
  );

  const oversizedIgnoreDirectory = path.join(external, "oversized-ignore-directory");
  mkdirSync(oversizedIgnoreDirectory);
  writeFileSync(path.join(oversizedIgnoreDirectory, ".gitignore"), Buffer.alloc(MAX_SKILL_IGNORE_BYTES + 1));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { skills: [oversizedIgnoreDirectory] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /skill attachment exceeds traversal limits/i,
  );

  const recursiveDirectory = path.join(external, "recursive-directory");
  mkdirSync(path.join(recursiveDirectory, "nested"), { recursive: true });
  symlinkSync(recursiveDirectory, path.join(recursiveDirectory, "nested", "recursive"));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { skills: [recursiveDirectory] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /recursive directory link/i,
  );

  const cancellableDirectory = path.join(external, "cancellable-directory");
  mkdirSync(cancellableDirectory);
  writeFileSync(
    path.join(cancellableDirectory, "SKILL.md"),
    "---\nname: cancellable\ndescription: Cancellable skill.\n---\n",
  );
  const controller = new AbortController();
  const pending = resolveResourceAttachments(
    { skills: [cancellableDirectory] },
    { cwd: project, projectTrusted: true, coreTools: [], signal: controller.signal },
  );
  queueMicrotask(() => controller.abort());
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});

test("rejects skill-name collisions using Pi's combined load behavior", async () => {
  const first = path.join(external, "first.md");
  const second = path.join(external, "second.md");
  writeFileSync(first, "---\nname: shared\ndescription: First skill.\n---\n");
  writeFileSync(second, "---\nname: shared\ndescription: Second skill.\n---\n");
  await assert.rejects(
    () =>
      resolveResourceAttachments({ skills: [first, second] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /duplicate skill names/i,
  );

  const collidingDirectory = path.join(external, "colliding-directory");
  mkdirSync(collidingDirectory);
  writeFileSync(path.join(collidingDirectory, "one.md"), "---\nname: nested-shared\ndescription: One.\n---\n");
  writeFileSync(path.join(collidingDirectory, "two.md"), "---\nname: nested-shared\ndescription: Two.\n---\n");
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { skills: [collidingDirectory] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /duplicate skill names/i,
  );

  const overlappingDirectory = path.join(external, "overlapping-directory");
  const overlappingSkill = path.join(overlappingDirectory, "skill.md");
  mkdirSync(overlappingDirectory);
  writeFileSync(overlappingSkill, "---\nname: overlapping\ndescription: Same file.\n---\n");
  assert.deepEqual(
    (
      await resolveResourceAttachments(
        { skills: [overlappingDirectory, overlappingSkill] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      )
    ).skills,
    [overlappingDirectory, overlappingSkill],
  );
});

test("allows explicit external resources but rejects every loaded project path when untrusted", async () => {
  const externalExtension = path.join(external, "external.ts");
  const externalSkill = path.join(external, "external-skill.md");
  const projectExtension = path.join(project, "project.ts");
  const projectSkillDirectory = path.join(project, "project-skill");
  const externalLink = path.join(project, "external-link.ts");
  const projectLink = path.join(external, "project-link.ts");
  const projectTreeLink = path.join(external, "project-tree");
  writeFileSync(externalExtension, "export default () => {};\n");
  writeFileSync(externalSkill, "---\nname: external\ndescription: External skill.\n---\n");
  writeFileSync(projectExtension, "export default () => {};\n");
  mkdirSync(projectSkillDirectory);
  writeFileSync(path.join(projectSkillDirectory, "SKILL.md"), "---\nname: project\ndescription: Project skill.\n---\n");
  symlinkSync(externalExtension, externalLink);
  symlinkSync(projectExtension, projectLink);

  const externalResult = await resolveResourceAttachments(
    { skills: [externalSkill], extensions: [{ path: externalExtension, tools: [] }] },
    { cwd: project, projectTrusted: false, coreTools: [] },
  );
  assert.deepEqual(externalResult.skills, [externalSkill]);
  assert.deepEqual(externalResult.extensions, [{ path: externalExtension, tools: [] }]);
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: "./external-link.ts", tools: [] }] },
        { cwd: project, projectTrusted: false, coreTools: [] },
      ),
    /project.*not trusted/i,
  );
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: projectLink, tools: [] }] },
        { cwd: project, projectTrusted: false, coreTools: [] },
      ),
    /project.*not trusted/i,
  );
  await assert.rejects(
    () => resolveResourceAttachments({ skills: [root] }, { cwd: project, projectTrusted: false, coreTools: [] }),
    /project.*not trusted/i,
  );

  symlinkSync(projectSkillDirectory, projectTreeLink);
  await assert.rejects(
    () => resolveResourceAttachments({ skills: [external] }, { cwd: project, projectTrusted: false, coreTools: [] }),
    /project.*not trusted/i,
  );

  writeFileSync(path.join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./project/project.ts"] } }));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: root, tools: [] }] },
        { cwd: project, projectTrusted: false, coreTools: [] },
      ),
    /project.*not trusted/i,
  );

  const symlinkedExtensionDirectory = path.join(external, "symlinked-extension");
  mkdirSync(symlinkedExtensionDirectory);
  symlinkSync(projectExtension, path.join(symlinkedExtensionDirectory, "index.ts"));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: symlinkedExtensionDirectory, tools: [] }] },
        { cwd: project, projectTrusted: false, coreTools: [] },
      ),
    /project.*not trusted/i,
  );
});

test("matches Pi package resolution and rejects incomplete or extensionless manifests", async () => {
  const packageDirectory = path.join(external, "package-extension");
  const indexTsDirectory = path.join(external, "index-ts-extension");
  const indexJsDirectory = path.join(external, "index-js-extension");
  const conventionPackage = path.join(external, "convention-package");
  const extensionsDirectory = path.join(conventionPackage, "extensions");
  const manifestOnlyDirectory = path.join(external, "manifest-without-extensions");
  const partialDirectory = path.join(external, "partial-extension");
  const unresolvableDirectory = path.join(external, "unresolvable-extension");
  for (const directory of [
    packageDirectory,
    indexTsDirectory,
    indexJsDirectory,
    extensionsDirectory,
    manifestOnlyDirectory,
    partialDirectory,
    unresolvableDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  mkdirSync(path.join(packageDirectory, "nested"));
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./first.ts", "./nested"] } }),
  );
  writeFileSync(path.join(packageDirectory, "first.ts"), "export default () => {};\n");
  writeFileSync(path.join(packageDirectory, "nested", "second.js"), "export default () => {};\n");
  writeFileSync(path.join(indexTsDirectory, "index.ts"), "export default () => {};\n");
  writeFileSync(path.join(indexTsDirectory, "index.js"), "export default () => {};\n");
  writeFileSync(path.join(indexJsDirectory, "index.js"), "export default () => {};\n");

  mkdirSync(path.join(extensionsDirectory, "indexed"));
  mkdirSync(path.join(extensionsDirectory, "packaged"));
  writeFileSync(path.join(extensionsDirectory, "direct.ts"), "export default () => {};\n");
  writeFileSync(path.join(extensionsDirectory, "indexed", "index.ts"), "export default () => {};\n");
  writeFileSync(
    path.join(extensionsDirectory, "packaged", "package.json"),
    JSON.stringify({ pi: { extensions: ["./entry.ts"] } }),
  );
  writeFileSync(path.join(extensionsDirectory, "packaged", "entry.ts"), "export default () => {};\n");

  assert.deepEqual(
    (
      await resolveResourceAttachments(
        {
          extensions: [packageDirectory, indexTsDirectory, indexJsDirectory, conventionPackage].map((path) => ({
            path,
            tools: [],
          })),
        },
        { cwd: project, projectTrusted: true, coreTools: [] },
      )
    ).extensions.map(({ path }) => path),
    [packageDirectory, indexTsDirectory, indexJsDirectory, conventionPackage],
  );

  writeFileSync(path.join(manifestOnlyDirectory, "package.json"), JSON.stringify({ pi: { skills: ["./SKILL.md"] } }));
  writeFileSync(path.join(manifestOnlyDirectory, "index.ts"), "export default () => {};\n");
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: manifestOnlyDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /at least one loadable Pi extension entrypoint/i,
  );

  writeFileSync(
    path.join(partialDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./valid.ts", "./missing.ts"] } }),
  );
  writeFileSync(path.join(partialDirectory, "valid.ts"), "export default () => {};\n");
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: partialDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /missing or unresolvable declared entrypoint/i,
  );

  writeFileSync(
    path.join(unresolvableDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./valid.ts", "./empty"] } }),
  );
  writeFileSync(path.join(unresolvableDirectory, "valid.ts"), "export default () => {};\n");
  mkdirSync(path.join(unresolvableDirectory, "empty"));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: unresolvableDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /missing or unresolvable declared entrypoint/i,
  );
});

test("rejects remote, missing, invalid, and oversized attachment inputs", async () => {
  const regularFile = path.join(external, "skill.md");
  writeFileSync(regularFile, "---\nname: review\ndescription: Review code.\n---\n");

  const invalidInputs: Array<{ value: Parameters<typeof resolveResourceAttachments>[0]; error: RegExp }> = [
    { value: { skills: "not-an-array" }, error: /skills.*array/i },
    { value: { extensions: "not-an-array" }, error: /extensions.*array/i },
    { value: { skills: ["npm:@scope/skill"] }, error: /local path/i },
    { value: { extensions: [{ path: "git:github.com/acme/ext", tools: [] }] }, error: /local path/i },
    { value: { skills: ["https://example.com/SKILL.md"] }, error: /local path/i },
    { value: { skills: ["//server/share/SKILL.md"] }, error: /local path/i },
    { value: { skills: ["\\\\server\\share\\SKILL.md"] }, error: /local path/i },
    { value: { skills: [path.join(external, "missing")] }, error: /does not exist/i },
    { value: { skills: [`${regularFile}\0suffix`] }, error: /control/i },
    { value: { skills: [`${regularFile}${"界".repeat(1_400)}`] }, error: /4096 UTF-8 bytes/i },
    { value: { extensions: [{ path: regularFile, tools: "read" }] }, error: /tools.*array/i },
    { value: { extensions: [{ path: regularFile, tools: ["bad,name"] }] }, error: /tool name/i },
    { value: { extensions: [{ path: regularFile, tools: ["bad\u001bname"] }] }, error: /tool name/i },
    { value: { extensions: [{ path: regularFile, tools: ["x".repeat(129)] }] }, error: /128 characters/i },
    { value: { extensions: [{ path: regularFile, tools: ["read"] }] }, error: /conflicts.*built-in read/i },
    {
      value: { extensions: [{ path: regularFile, tools: ["subagent_send"] }] },
      error: /conflicts.*built-in subagent_send/i,
    },
  ];

  for (const { value, error } of invalidInputs) {
    await assert.rejects(
      () => resolveResourceAttachments(value, { cwd: project, projectTrusted: true, coreTools: [] }),
      error,
    );
  }

  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { skills: Array.from({ length: MAX_ATTACHED_SKILLS + 1 }, () => regularFile) },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    new RegExp(`at most ${MAX_ATTACHED_SKILLS}`, "i"),
  );
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        {
          extensions: Array.from({ length: MAX_ATTACHED_EXTENSIONS + 1 }, (_, index) => ({
            path: path.join(external, `extension-${index}.ts`),
            tools: [],
          })),
        },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    new RegExp(`at most ${MAX_ATTACHED_EXTENSIONS}`, "i"),
  );
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        {
          extensions: [
            {
              path: regularFile,
              tools: Array.from({ length: MAX_SELECTED_TOOLS }, (_, index) => `tool_${index}`),
            },
          ],
        },
        { cwd: project, projectTrusted: true, coreTools: ["read"] },
      ),
    new RegExp(`at most ${MAX_SELECTED_TOOLS}`, "i"),
  );
});

test("rejects unsupported filesystem object types", { skip: process.platform === "win32" }, async () => {
  const fifoPath = path.join(external, "fifo");
  const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  await assert.rejects(
    () => resolveResourceAttachments({ skills: [fifoPath] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /file or directory/i,
  );
});
