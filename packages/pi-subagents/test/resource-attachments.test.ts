import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import { toolSourceId } from "../src/attachment-utils.js";
import {
  MAX_ATTACHED_EXTENSIONS,
  MAX_ATTACHED_SKILLS,
  MAX_EXTENSION_METADATA_BYTES,
  MAX_EXTENSION_SCAN_ENTRIES,
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
    toolSources: {
      search_code: [toolSourceId(extension)],
      fetch_issue: [toolSourceId(extension)],
    },
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

test("ignores broken declared skill links excluded by Pi ignore files", async () => {
  for (const [index, filename] of [".gitignore", ".ignore", ".fdignore"].entries()) {
    const directory = path.join(external, `ignored-broken-${index}`);
    mkdirSync(path.join(directory, "nested"), { recursive: true });
    writeFileSync(path.join(directory, filename), "SKILL.md\nnested/SKILL.md\ndraft.md\n");
    writeFileSync(path.join(directory, "valid.md"), `---\nname: valid-${index}\ndescription: Valid.\n---\n`);
    for (const ignored of ["SKILL.md", "nested/SKILL.md", "draft.md"]) {
      symlinkSync(path.join(directory, "missing.md"), path.join(directory, ignored));
    }
    const resolved = await resolveResourceAttachments(
      { skills: [directory] },
      { cwd: project, projectTrusted: true, coreTools: [] },
    );
    assert.deepEqual(resolved.skills, [directory]);
  }
});

test("ties selected extension tools to their resolved entrypoints", async () => {
  const first = path.join(external, "first.ts");
  const second = path.join(external, "second.ts");
  writeFileSync(first, "export default () => {};\n");
  writeFileSync(second, "export default () => {};\n");
  const resolved = await resolveResourceAttachments(
    {
      extensions: [
        { path: first, tools: [] },
        { path: second, tools: ["search_custom"] },
      ],
    },
    { cwd: project, projectTrusted: true, coreTools: [] },
  );
  assert.deepEqual(resolved.toolSources, { search_custom: [toolSourceId(second)] });
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        {
          extensions: [
            { path: first, tools: ["search_custom"] },
            { path: second, tools: ["search_custom"] },
          ],
        },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /requested by multiple attachments/i,
  );
});

test("matches Pi's tool source for a package entrypoint outside its root", async () => {
  const packageDirectory = path.join(external, "package-with-external-entry");
  const entrypoint = path.join(external, "outside.js");
  mkdirSync(packageDirectory);
  writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ pi: { extensions: ["../outside.js"] } }));
  writeFileSync(
    entrypoint,
    'export default (pi) => pi.registerTool({ name: "outside_tool", label: "Outside", description: "Test", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });\n',
  );
  const resolved = await resolveResourceAttachments(
    { extensions: [{ path: packageDirectory, tools: ["outside_tool"] }] },
    { cwd: project, projectTrusted: true, coreTools: [] },
  );
  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir: project,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [packageDirectory],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const owner = loaded.extensions[0]?.tools.get("outside_tool")?.sourceInfo.path;
  assert.ok(owner);
  assert.ok(resolved.toolSources.outside_tool?.includes(toolSourceId(owner)));
});

test("attests a shared extension entrypoint using Pi's first lexical alias", async () => {
  const shared = path.join(external, "shared-extension.js");
  writeFileSync(
    shared,
    'export default (pi) => pi.registerTool({ name: "alias_tool", label: "Alias", description: "Test", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });\n',
  );
  const packageDirectories = ["first-alias", "second-alias"].map((name) => path.join(external, name));
  for (const packageDirectory of packageDirectories) {
    mkdirSync(packageDirectory);
    symlinkSync(shared, path.join(packageDirectory, "entry.js"));
    writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ pi: { extensions: ["./entry.js"] } }));
  }
  const resolved = await resolveResourceAttachments(
    {
      extensions: [
        { path: packageDirectories[0], tools: [] },
        { path: packageDirectories[1], tools: ["alias_tool"] },
      ],
    },
    { cwd: project, projectTrusted: true, coreTools: [] },
  );
  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir: project,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: packageDirectories,
    noExtensions: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const owner = loaded.extensions[0]?.tools.get("alias_tool")?.sourceInfo.path;
  assert.ok(owner);
  assert.equal(owner, path.join(packageDirectories[0], "entry.js"));
  assert.deepEqual(resolved.toolSources, { alias_tool: [toolSourceId(owner)] });
});

test("bounds and cancels attachment directory preflight", async () => {
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

  const wideExtensionDirectory = path.join(external, "wide-extension-directory");
  mkdirSync(wideExtensionDirectory);
  for (let index = 0; index <= MAX_EXTENSION_SCAN_ENTRIES; index++) {
    writeFileSync(path.join(wideExtensionDirectory, String(index)), "");
  }
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: wideExtensionDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /extension attachment exceeds preflight limits/i,
  );

  const widePackageDirectory = path.join(external, "wide-package-directory");
  mkdirSync(path.join(widePackageDirectory, "extensions"), { recursive: true });
  mkdirSync(path.join(widePackageDirectory, "prompts"));
  writeFileSync(path.join(widePackageDirectory, "extensions", "valid.ts"), "export default () => {};\n");
  for (let index = 0; index < MAX_EXTENSION_SCAN_ENTRIES; index++) {
    writeFileSync(path.join(widePackageDirectory, "prompts", `${index}.md`), "");
  }
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: widePackageDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /extension attachment exceeds preflight limits/i,
  );

  const oversizedManifestDirectory = path.join(external, "oversized-manifest-directory");
  mkdirSync(oversizedManifestDirectory);
  writeFileSync(path.join(oversizedManifestDirectory, "package.json"), Buffer.alloc(MAX_EXTENSION_METADATA_BYTES + 1));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: oversizedManifestDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /extension attachment exceeds preflight limits/i,
  );

  const oversizedDeclarationDirectory = path.join(external, "oversized-declaration-directory");
  mkdirSync(oversizedDeclarationDirectory);
  writeFileSync(
    path.join(oversizedDeclarationDirectory, "package.json"),
    JSON.stringify({
      pi: {
        extensions: Array.from({ length: MAX_EXTENSION_SCAN_ENTRIES + 1 }, (_, index) => `!ignored-${index}.ts`),
      },
    }),
  );
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: oversizedDeclarationDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /extension attachment exceeds preflight limits/i,
  );

  const recursiveResourceDirectory = path.join(external, "recursive-resource-directory");
  const recursiveExtensionDirectory = path.join(recursiveResourceDirectory, "extensions");
  const recursivePromptDirectory = path.join(recursiveResourceDirectory, "prompts");
  mkdirSync(recursiveExtensionDirectory, { recursive: true });
  mkdirSync(path.join(recursivePromptDirectory, "nested"), { recursive: true });
  writeFileSync(path.join(recursiveExtensionDirectory, "valid.ts"), "export default () => {};\n");
  symlinkSync(recursivePromptDirectory, path.join(recursivePromptDirectory, "nested", "recursive"));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: recursiveResourceDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /recursive resource directory link/i,
  );

  const cancellableExtensionDirectory = path.join(external, "cancellable-extension-directory");
  mkdirSync(cancellableExtensionDirectory);
  writeFileSync(path.join(cancellableExtensionDirectory, "index.ts"), "export default () => {};\n");
  const extensionController = new AbortController();
  const pendingExtension = resolveResourceAttachments(
    { extensions: [{ path: cancellableExtensionDirectory, tools: [] }] },
    { cwd: project, projectTrusted: true, coreTools: [], signal: extensionController.signal },
  );
  queueMicrotask(() => extensionController.abort());
  await assert.rejects(pendingExtension, (error: Error) => error.name === "AbortError");
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

  const firstPackage = path.join(external, "first-skill-package");
  const secondPackage = path.join(external, "second-skill-package");
  for (const [packageDirectory, description] of [
    [firstPackage, "First package skill."],
    [secondPackage, "Second package skill."],
  ]) {
    mkdirSync(packageDirectory);
    writeFileSync(path.join(packageDirectory, "extension.ts"), "export default () => {};\n");
    writeFileSync(path.join(packageDirectory, "skill.md"), `---\nname: shared\ndescription: ${description}\n---\n`);
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ pi: { extensions: ["./extension.ts"], skills: ["./skill.md"] } }),
    );
  }
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { skills: [first], extensions: [{ path: firstPackage, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /duplicate skill names/i,
  );
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        {
          extensions: [
            { path: firstPackage, tools: [] },
            { path: secondPackage, tools: [] },
          ],
        },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /duplicate skill names/i,
  );
});

test("rejects every invalid enabled extension-package skill", async () => {
  for (const [index, content] of ["Not a skill.\n", "---\nname: missing-description\n---\n"].entries()) {
    const packageDirectory = path.join(external, `invalid-package-skill-${index}`);
    mkdirSync(packageDirectory);
    writeFileSync(path.join(packageDirectory, "extension.ts"), "export default () => {};\n");
    writeFileSync(path.join(packageDirectory, "skill.md"), content);
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ pi: { extensions: ["./extension.ts"], skills: ["./skill.md"] } }),
    );

    await assert.rejects(
      () =>
        resolveResourceAttachments(
          { extensions: [{ path: packageDirectory, tools: [] }] },
          { cwd: project, projectTrusted: true, coreTools: [] },
        ),
      /invalid or unreadable declared skill/i,
    );
  }
});

test("rejects missing exact package skills before Pi silently omits them", async () => {
  const packageDirectory = path.join(external, "missing-package-skill");
  mkdirSync(packageDirectory);
  writeFileSync(path.join(packageDirectory, "extension.ts"), "export default () => {};\n");
  writeFileSync(path.join(packageDirectory, "valid.md"), "---\nname: valid\ndescription: Valid skill.\n---\n");
  const manifestPath = path.join(packageDirectory, "package.json");
  for (const missing of ["./missing.md", "./missing-directory"]) {
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pi: {
          extensions: ["./extension.ts"],
          skills: ["./valid.md", missing],
          prompts: ["./missing-prompt.md"],
          themes: ["./missing-theme.json"],
        },
      }),
    );
    await assert.rejects(
      () =>
        resolveResourceAttachments(
          { extensions: [{ path: packageDirectory, tools: [] }] },
          { cwd: project, projectTrusted: true, coreTools: [] },
        ),
      /missing or unreadable declared skill/i,
    );
  }

  writeFileSync(
    manifestPath,
    JSON.stringify({
      pi: {
        extensions: ["./extension.ts"],
        skills: ["./valid.md"],
        prompts: ["./missing-prompt.md"],
        themes: ["./missing-theme.json"],
      },
    }),
  );
  const resolved = await resolveResourceAttachments(
    { extensions: [{ path: packageDirectory, tools: [] }] },
    { cwd: project, projectTrusted: true, coreTools: [] },
  );
  assert.deepEqual(resolved.extensions, [{ path: packageDirectory, tools: [] }]);
});

test("rejects omitted skill candidates in package directories but preserves Pi ignores", async () => {
  const packageDirectory = path.join(external, "partial-package-skill-directory");
  const skillsDirectory = path.join(packageDirectory, "skills");
  const nestedDirectory = path.join(skillsDirectory, "nested");
  mkdirSync(nestedDirectory, { recursive: true });
  writeFileSync(path.join(packageDirectory, "extension.ts"), "export default () => {};\n");
  writeFileSync(path.join(skillsDirectory, "valid.md"), "---\nname: valid\ndescription: Valid skill.\n---\n");
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./extension.ts"], skills: ["./skills"] } }),
  );
  const resolvePackage = () =>
    resolveResourceAttachments(
      { extensions: [{ path: packageDirectory, tools: [] }] },
      { cwd: project, projectTrusted: true, coreTools: [] },
    );

  for (const relativePath of ["SKILL.md", "draft.md", "nested/SKILL.md"]) {
    const broken = path.join(skillsDirectory, relativePath);
    symlinkSync(path.join(skillsDirectory, "missing.md"), broken);
    await assert.rejects(resolvePackage, /invalid or unreadable declared skill/i);
    rmSync(broken);
  }

  for (const [relativePath, ignorePath] of [
    ["SKILL.md", path.join(skillsDirectory, ".gitignore")],
    ["nested/SKILL.md", path.join(nestedDirectory, ".fdignore")],
  ]) {
    const broken = path.join(skillsDirectory, relativePath);
    symlinkSync(path.join(skillsDirectory, "missing.md"), broken);
    writeFileSync(ignorePath, "SKILL.md\n");
    assert.deepEqual((await resolvePackage()).extensions, [{ path: packageDirectory, tools: [] }]);
    rmSync(broken);
    rmSync(ignorePath);
  }

  const undiscoverable = path.join(nestedDirectory, "notes.md");
  symlinkSync(path.join(skillsDirectory, "missing.md"), undiscoverable);
  assert.deepEqual((await resolvePackage()).extensions, [{ path: packageDirectory, tools: [] }]);

  const conventionPackage = path.join(external, "partial-convention-skills");
  mkdirSync(path.join(conventionPackage, "extensions"), { recursive: true });
  mkdirSync(path.join(conventionPackage, "skills"));
  writeFileSync(path.join(conventionPackage, "extensions", "valid.ts"), "export default () => {};\n");
  writeFileSync(
    path.join(conventionPackage, "skills", "valid.md"),
    "---\nname: convention\ndescription: Valid skill.\n---\n",
  );
  symlinkSync(path.join(conventionPackage, "skills", "missing.md"), path.join(conventionPackage, "skills", "SKILL.md"));
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: conventionPackage, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /invalid or unreadable declared skill/i,
  );
});

test("bounds extension-package skill content before synchronous loading", async () => {
  const packageDirectory = path.join(external, "oversized-package-skills");
  const skillBodyBytes = Math.floor(MAX_SKILL_SCAN_BYTES / 2);
  mkdirSync(packageDirectory);
  writeFileSync(path.join(packageDirectory, "extension.ts"), "export default () => {};\n");
  writeFileSync(path.join(packageDirectory, "first.md"), `Not a skill.\n${"x".repeat(skillBodyBytes)}`);
  writeFileSync(
    path.join(packageDirectory, "second.md"),
    `---\nname: second\ndescription: Second package skill.\n---\n${"x".repeat(skillBodyBytes)}`,
  );
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      pi: { extensions: ["./extension.ts"], skills: ["./first.md", "./second.md"] },
    }),
  );

  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: packageDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /skill attachment exceeds traversal limits/i,
  );
});

test("deduplicates canonical package skill paths before applying shared content limits", async () => {
  const sharedSkill = path.join(external, "shared-large-skill.md");
  writeFileSync(
    sharedSkill,
    `---\nname: shared-large\ndescription: Shared large package skill.\n---\n${"x".repeat(Math.floor(MAX_SKILL_SCAN_BYTES / 2) + 1)}`,
  );
  const packageDirectories = ["first-shared-package", "second-shared-package"].map((name) => path.join(external, name));
  for (const packageDirectory of packageDirectories) {
    mkdirSync(packageDirectory);
    writeFileSync(path.join(packageDirectory, "extension.ts"), "export default () => {};\n");
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ pi: { extensions: ["./extension.ts"], skills: ["../shared-large-skill.md"] } }),
    );
  }

  const packageOnly = await resolveResourceAttachments(
    { extensions: packageDirectories.map((extensionPath) => ({ path: extensionPath, tools: [] })) },
    { cwd: project, projectTrusted: true, coreTools: [] },
  );
  assert.equal(packageOnly.extensions.length, 2);

  const explicitAndPackage = await resolveResourceAttachments(
    { skills: [sharedSkill], extensions: [{ path: packageDirectories[0], tools: [] }] },
    { cwd: project, projectTrusted: true, coreTools: [] },
  );
  assert.deepEqual(explicitAndPackage.skills, [sharedSkill]);
});

test("allows explicit external resources but rejects every loaded project path when untrusted", async () => {
  const externalExtension = path.join(external, "external.ts");
  const externalSkill = path.join(external, "external-skill.md");
  const projectExtension = path.join(project, "project.ts");
  const projectSkillDirectory = path.join(project, "project-skill");
  const projectPrompt = path.join(project, "project-prompt.md");
  const projectTheme = path.join(project, "project-theme.json");
  const externalLink = path.join(project, "external-link.ts");
  const projectLink = path.join(external, "project-link.ts");
  const projectTreeLink = path.join(external, "project-tree");
  writeFileSync(externalExtension, "export default () => {};\n");
  writeFileSync(externalSkill, "---\nname: external\ndescription: External skill.\n---\n");
  writeFileSync(projectExtension, "export default () => {};\n");
  mkdirSync(projectSkillDirectory);
  writeFileSync(path.join(projectSkillDirectory, "SKILL.md"), "---\nname: project\ndescription: Project skill.\n---\n");
  writeFileSync(projectPrompt, "Project prompt\n");
  writeFileSync(projectTheme, "{}\n");
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

  const externalPackage = path.join(external, "external-package");
  const externalPackageExtension = path.join(externalPackage, "extension.ts");
  mkdirSync(externalPackage);
  writeFileSync(externalPackageExtension, "export default () => {};\n");
  for (const [resourceType, resourcePath] of [
    ["skills", projectSkillDirectory],
    ["prompts", projectPrompt],
    ["themes", projectTheme],
    ["skills", projectTreeLink],
  ] as const) {
    writeFileSync(
      path.join(externalPackage, "package.json"),
      JSON.stringify({ pi: { extensions: [externalPackageExtension], [resourceType]: [resourcePath] } }),
    );
    await assert.rejects(
      () =>
        resolveResourceAttachments(
          { extensions: [{ path: externalPackage, tools: [] }] },
          { cwd: project, projectTrusted: false, coreTools: [] },
        ),
      /project.*not trusted/i,
    );
  }

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

test("applies manifest overrides before trust-gating resolved resources", async () => {
  const packageDirectory = path.join(external, "overridden-project-resources");
  const extension = path.join(packageDirectory, "extension.ts");
  const projectExtension = path.join(project, "disabled-extension.ts");
  const projectSkill = path.join(project, "disabled-skill.md");
  const projectPrompt = path.join(project, "disabled-prompt.md");
  const projectTheme = path.join(project, "disabled-theme.json");
  mkdirSync(packageDirectory);
  writeFileSync(extension, "export default () => {};\n");
  writeFileSync(projectExtension, "export default () => {};\n");
  writeFileSync(projectSkill, "---\nname: disabled-skill\ndescription: Disabled skill.\n---\n");
  writeFileSync(projectPrompt, "Disabled prompt.\n");
  writeFileSync(projectTheme, "{}\n");

  const manifestEntries = (resourcePath: string) => {
    const relativePath = path.relative(packageDirectory, resourcePath).split(path.sep).join("/");
    return [relativePath, `-${relativePath}`];
  };
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      pi: {
        extensions: ["./extension.ts", ...manifestEntries(projectExtension)],
        skills: manifestEntries(projectSkill),
        prompts: manifestEntries(projectPrompt),
        themes: manifestEntries(projectTheme),
      },
    }),
  );

  const result = await resolveResourceAttachments(
    { extensions: [{ path: packageDirectory, tools: [] }] },
    { cwd: project, projectTrusted: false, coreTools: [] },
  );

  assert.deepEqual(result.extensions, [{ path: packageDirectory, tools: [] }]);
});

test("skips ignored or undiscoverable project symlinks before enforcing trust", async () => {
  const packageDirectory = path.join(external, "ignored-project-symlinks");
  const extensionsDirectory = path.join(packageDirectory, "extensions");
  const skillsDirectory = path.join(packageDirectory, "skills");
  const promptsDirectory = path.join(packageDirectory, "prompts");
  const themesDirectory = path.join(packageDirectory, "themes");
  for (const directory of [extensionsDirectory, skillsDirectory, promptsDirectory, themesDirectory]) {
    mkdirSync(directory, { recursive: true });
  }

  const projectExtension = path.join(project, "ignored-extension.ts");
  const projectSkill = path.join(project, "ignored-skill.md");
  const projectSkillDirectory = path.join(project, "ignored-skill-directory");
  const projectPrompt = path.join(project, "ignored-prompt.md");
  const projectThemeDirectory = path.join(project, "ignored-theme-directory");
  const projectNonResource = path.join(project, "notes.txt");
  writeFileSync(projectExtension, "export default () => {};\n");
  writeFileSync(projectSkill, "---\nname: ignored-skill\ndescription: Ignored project skill.\n---\n");
  mkdirSync(projectSkillDirectory);
  writeFileSync(
    path.join(projectSkillDirectory, "SKILL.md"),
    "---\nname: ignored-directory\ndescription: Ignored project skill directory.\n---\n",
  );
  writeFileSync(projectPrompt, "Ignored project prompt.\n");
  mkdirSync(projectThemeDirectory);
  writeFileSync(path.join(projectThemeDirectory, "ignored.json"), "{}\n");
  writeFileSync(projectNonResource, "Not a Pi package resource.\n");

  writeFileSync(path.join(extensionsDirectory, "valid.ts"), "export default () => {};\n");
  symlinkSync(projectExtension, path.join(extensionsDirectory, "ignored.ts"));
  symlinkSync(projectNonResource, path.join(extensionsDirectory, "notes.txt"));
  writeFileSync(path.join(extensionsDirectory, ".gitignore"), "ignored.ts\n");

  const nestedSkillsDirectory = path.join(skillsDirectory, "nested");
  mkdirSync(nestedSkillsDirectory);
  symlinkSync(projectSkill, path.join(skillsDirectory, "ignored.md"));
  symlinkSync(projectSkillDirectory, path.join(skillsDirectory, "ignored-directory"));
  symlinkSync(projectNonResource, path.join(skillsDirectory, "notes.txt"));
  symlinkSync(projectSkill, path.join(nestedSkillsDirectory, "notes.md"));
  writeFileSync(path.join(skillsDirectory, ".gitignore"), "ignored.md\nignored-directory/\n");

  symlinkSync(projectPrompt, path.join(promptsDirectory, "ignored.md"));
  symlinkSync(projectNonResource, path.join(promptsDirectory, "notes.txt"));
  writeFileSync(path.join(promptsDirectory, ".gitignore"), "ignored.md\n");

  symlinkSync(projectThemeDirectory, path.join(themesDirectory, "ignored-directory"));
  symlinkSync(projectNonResource, path.join(themesDirectory, "notes.txt"));
  writeFileSync(path.join(themesDirectory, ".gitignore"), "ignored-directory/\n");

  const result = await resolveResourceAttachments(
    { extensions: [{ path: packageDirectory, tools: [] }] },
    { cwd: project, projectTrusted: false, coreTools: [] },
  );

  assert.deepEqual(result.extensions, [{ path: packageDirectory, tools: [] }]);
});

test("package skill roots shadow nested project paths", async () => {
  const packageDirectory = path.join(external, "root-skill-package");
  const skillsDirectory = path.join(packageDirectory, "skills");
  const projectSkillDirectory = path.join(project, "project-skill");
  mkdirSync(skillsDirectory, { recursive: true });
  mkdirSync(projectSkillDirectory);
  writeFileSync(path.join(packageDirectory, "extension.ts"), "export default () => {};\n");
  writeFileSync(path.join(skillsDirectory, "SKILL.md"), "---\nname: root\ndescription: Root skill.\n---\n");
  writeFileSync(path.join(projectSkillDirectory, "SKILL.md"), "---\nname: project\ndescription: Project skill.\n---\n");
  symlinkSync(projectSkillDirectory, path.join(skillsDirectory, "shadowed"));
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./extension.ts"], skills: ["./skills"] } }),
  );

  const result = await resolveResourceAttachments(
    { extensions: [{ path: packageDirectory, tools: [] }] },
    { cwd: project, projectTrusted: false, coreTools: [] },
  );
  assert.deepEqual(result.extensions, [{ path: packageDirectory, tools: [] }]);
});

test("nested package skill ignores skip project paths before trust checks", async () => {
  const packageDirectory = path.join(external, "nested-ignore-package");
  const nestedDirectory = path.join(packageDirectory, "skills", "nested");
  const projectSkillDirectory = path.join(project, "project-skill");
  mkdirSync(path.join(nestedDirectory, "valid"), { recursive: true });
  mkdirSync(projectSkillDirectory);
  writeFileSync(path.join(packageDirectory, "extension.ts"), "export default () => {};\n");
  writeFileSync(path.join(nestedDirectory, "valid", "SKILL.md"), "---\nname: valid\ndescription: Valid skill.\n---\n");
  writeFileSync(path.join(projectSkillDirectory, "SKILL.md"), "---\nname: project\ndescription: Project skill.\n---\n");
  symlinkSync(projectSkillDirectory, path.join(nestedDirectory, "ignored"));
  writeFileSync(path.join(nestedDirectory, ".fdignore"), "ignored/\n");
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./extension.ts"], skills: ["./skills"] } }),
  );

  const result = await resolveResourceAttachments(
    { extensions: [{ path: packageDirectory, tools: [] }] },
    { cwd: project, projectTrusted: false, coreTools: [] },
  );
  assert.deepEqual(result.extensions, [{ path: packageDirectory, tools: [] }]);
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
  const nestedUnresolvableDirectory = path.join(external, "nested-unresolvable-extension");
  const globDirectory = path.join(external, "glob-extension");
  const resourceGlobDirectory = path.join(external, "resource-glob-extension");
  for (const directory of [
    packageDirectory,
    indexTsDirectory,
    indexJsDirectory,
    extensionsDirectory,
    manifestOnlyDirectory,
    partialDirectory,
    unresolvableDirectory,
    nestedUnresolvableDirectory,
    globDirectory,
    resourceGlobDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  mkdirSync(path.join(packageDirectory, "nested"));
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./first.ts", "./nested", "!**/*.test.ts"] } }),
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
  writeFileSync(
    path.join(manifestOnlyDirectory, "SKILL.md"),
    "---\nname: manifest-only\ndescription: Valid skill.\n---\n",
  );
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

  const nestedPackage = path.join(nestedUnresolvableDirectory, "nested");
  mkdirSync(path.join(nestedPackage, "empty"), { recursive: true });
  writeFileSync(
    path.join(nestedUnresolvableDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./nested"] } }),
  );
  writeFileSync(
    path.join(nestedPackage, "package.json"),
    JSON.stringify({ pi: { extensions: ["./valid.ts", "./empty"] } }),
  );
  writeFileSync(path.join(nestedPackage, "valid.ts"), "export default () => {};\n");
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: nestedUnresolvableDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /missing or unresolvable declared entrypoint/i,
  );

  writeFileSync(
    path.join(globDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./valid.ts", "./**/*.ts"] } }),
  );
  writeFileSync(path.join(globDirectory, "valid.ts"), "export default () => {};\n");
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: globDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /must not contain glob entrypoint declarations/i,
  );

  writeFileSync(
    path.join(resourceGlobDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./valid.ts"], skills: ["./**/*.md"] } }),
  );
  writeFileSync(path.join(resourceGlobDirectory, "valid.ts"), "export default () => {};\n");
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: resourceGlobDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /must not contain glob resource declarations/i,
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

  const skillDirectory = path.join(external, "fifo-ignore-skill");
  mkdirSync(skillDirectory);
  writeFileSync(path.join(skillDirectory, "SKILL.md"), "---\nname: fifo-skill\ndescription: FIFO skill.\n---\n");
  const skillIgnore = path.join(skillDirectory, ".gitignore");
  const skillIgnoreCreated = spawnSync("mkfifo", [skillIgnore], { encoding: "utf8" });
  assert.equal(skillIgnoreCreated.status, 0, skillIgnoreCreated.stderr);
  await assert.rejects(
    () =>
      resolveResourceAttachments({ skills: [skillDirectory] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /ignore files must be regular files/i,
  );

  const extensionManifestDirectory = path.join(external, "fifo-manifest-extension");
  mkdirSync(extensionManifestDirectory);
  const extensionManifest = path.join(extensionManifestDirectory, "package.json");
  const extensionManifestCreated = spawnSync("mkfifo", [extensionManifest], { encoding: "utf8" });
  assert.equal(extensionManifestCreated.status, 0, extensionManifestCreated.stderr);
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: extensionManifestDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /manifest must be a regular file/i,
  );

  const fifoPackageSkillDirectory = path.join(external, "fifo-package-skill");
  mkdirSync(fifoPackageSkillDirectory);
  writeFileSync(path.join(fifoPackageSkillDirectory, "extension.ts"), "export default () => {};\n");
  const fifoPackageSkill = path.join(fifoPackageSkillDirectory, "SKILL.md");
  assert.equal(spawnSync("mkfifo", [fifoPackageSkill], { encoding: "utf8" }).status, 0);
  writeFileSync(
    path.join(fifoPackageSkillDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: ["./extension.ts"], skills: ["./SKILL.md"] } }),
  );
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: fifoPackageSkillDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /missing or unreadable declared skill/i,
  );

  const fifoSkillTreePackage = path.join(external, "fifo-skill-tree-package");
  const fifoSkillTree = path.join(fifoSkillTreePackage, "skills");
  mkdirSync(fifoSkillTree, { recursive: true });
  writeFileSync(path.join(fifoSkillTreePackage, "extension.ts"), "export default () => {};\n");
  writeFileSync(path.join(fifoSkillTree, "valid.md"), "---\nname: valid-fifo-sibling\ndescription: Valid.\n---\n");
  assert.equal(spawnSync("mkfifo", [path.join(fifoSkillTree, "SKILL.md")], { encoding: "utf8" }).status, 0);
  writeFileSync(
    path.join(fifoSkillTreePackage, "package.json"),
    JSON.stringify({ pi: { extensions: ["./extension.ts"], skills: ["./skills"] } }),
  );
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: fifoSkillTreePackage, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /invalid or unreadable declared skill/i,
  );

  const packageResourceDirectory = path.join(external, "fifo-ignore-package-resource");
  mkdirSync(path.join(packageResourceDirectory, "extensions"), { recursive: true });
  mkdirSync(path.join(packageResourceDirectory, "prompts"));
  writeFileSync(path.join(packageResourceDirectory, "extensions", "valid.ts"), "export default () => {};\n");
  const packageResourceIgnore = path.join(packageResourceDirectory, "prompts", ".fdignore");
  const packageResourceIgnoreCreated = spawnSync("mkfifo", [packageResourceIgnore], { encoding: "utf8" });
  assert.equal(packageResourceIgnoreCreated.status, 0, packageResourceIgnoreCreated.stderr);
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: packageResourceDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /ignore files must be regular files/i,
  );

  const extensionDirectory = path.join(external, "fifo-ignore-extension");
  mkdirSync(extensionDirectory);
  writeFileSync(path.join(extensionDirectory, "valid.ts"), "export default () => {};\n");
  const extensionIgnore = path.join(extensionDirectory, ".ignore");
  const extensionIgnoreCreated = spawnSync("mkfifo", [extensionIgnore], { encoding: "utf8" });
  assert.equal(extensionIgnoreCreated.status, 0, extensionIgnoreCreated.stderr);
  await assert.rejects(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: extensionDirectory, tools: [] }] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /ignore files must be regular files/i,
  );
});
