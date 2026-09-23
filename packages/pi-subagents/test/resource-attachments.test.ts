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

test("canonicalizes, deduplicates, and merges explicit local attachments", () => {
  const skill = path.join(project, "skills", "review");
  const extension = path.join(project, "extensions", "search.ts");
  mkdirSync(skill, { recursive: true });
  mkdirSync(path.dirname(extension), { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: review\ndescription: Review code.\n---\n");
  writeFileSync(extension, "export default () => {};\n");

  const result = resolveResourceAttachments(
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

test("accepts only skill paths that Pi loads", () => {
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
    resolveResourceAttachments(
      {
        skills: [directSkill, disabledSkill, warningSkill, skillDirectory, rootMarkdownDirectory, nestedSkillDirectory],
      },
      { cwd: project, projectTrusted: true, coreTools: [] },
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
    assert.throws(
      () => resolveResourceAttachments({ skills: [skill] }, { cwd: project, projectTrusted: true, coreTools: [] }),
      /at least one loadable Pi skill/i,
    );
  }
});

test("rejects a skill directory when Pi omits an invalid declared skill", () => {
  const partialDirectory = path.join(external, "partial-directory");
  mkdirSync(path.join(partialDirectory, "broken"), { recursive: true });
  writeFileSync(path.join(partialDirectory, "valid.md"), "---\nname: valid\ndescription: Valid skill.\n---\n");
  writeFileSync(path.join(partialDirectory, "broken", "SKILL.md"), "---\nname: broken\n---\n");

  assert.throws(
    () =>
      resolveResourceAttachments({ skills: [partialDirectory] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /invalid or unreadable declared skill/i,
  );

  const brokenLinkDirectory = path.join(external, "broken-link-directory");
  mkdirSync(path.join(brokenLinkDirectory, "broken"), { recursive: true });
  writeFileSync(path.join(brokenLinkDirectory, "valid.md"), "---\nname: valid-link\ndescription: Valid skill.\n---\n");
  symlinkSync(path.join(brokenLinkDirectory, "missing.md"), path.join(brokenLinkDirectory, "broken", "SKILL.md"));
  assert.throws(
    () =>
      resolveResourceAttachments(
        { skills: [brokenLinkDirectory] },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    /invalid or unreadable declared skill/i,
  );

  const ignoredDirectory = path.join(external, "partially-ignored-directory");
  mkdirSync(path.join(ignoredDirectory, "ignored"), { recursive: true });
  writeFileSync(path.join(ignoredDirectory, ".gitignore"), "ignored/SKILL.md\n");
  writeFileSync(path.join(ignoredDirectory, "valid.md"), "---\nname: valid-ignore\ndescription: Valid skill.\n---\n");
  writeFileSync(
    path.join(ignoredDirectory, "ignored", "SKILL.md"),
    "---\nname: ignored-partial\ndescription: Ignored skill.\n---\n",
  );
  assert.throws(
    () =>
      resolveResourceAttachments({ skills: [ignoredDirectory] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /invalid or unreadable declared skill/i,
  );
});

test("rejects skill-name collisions using Pi's combined load behavior", () => {
  const first = path.join(external, "first.md");
  const second = path.join(external, "second.md");
  writeFileSync(first, "---\nname: shared\ndescription: First skill.\n---\n");
  writeFileSync(second, "---\nname: shared\ndescription: Second skill.\n---\n");
  assert.throws(
    () =>
      resolveResourceAttachments({ skills: [first, second] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /duplicate skill names/i,
  );

  const collidingDirectory = path.join(external, "colliding-directory");
  mkdirSync(collidingDirectory);
  writeFileSync(path.join(collidingDirectory, "one.md"), "---\nname: nested-shared\ndescription: One.\n---\n");
  writeFileSync(path.join(collidingDirectory, "two.md"), "---\nname: nested-shared\ndescription: Two.\n---\n");
  assert.throws(
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
    resolveResourceAttachments(
      { skills: [overlappingDirectory, overlappingSkill] },
      { cwd: project, projectTrusted: true, coreTools: [] },
    ).skills,
    [overlappingDirectory, overlappingSkill],
  );
});

test("allows an explicit external resource but rejects lexical and canonical project paths when untrusted", () => {
  const externalExtension = path.join(external, "external.ts");
  const projectExtension = path.join(project, "project.ts");
  const externalLink = path.join(project, "external-link.ts");
  const projectLink = path.join(external, "project-link.ts");
  writeFileSync(externalExtension, "export default () => {};\n");
  writeFileSync(projectExtension, "export default () => {};\n");
  symlinkSync(externalExtension, externalLink);
  symlinkSync(projectExtension, projectLink);

  assert.deepEqual(
    resolveResourceAttachments(
      { extensions: [{ path: externalExtension, tools: [] }] },
      { cwd: project, projectTrusted: false, coreTools: [] },
    ).extensions,
    [{ path: externalExtension, tools: [] }],
  );
  assert.throws(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: "./external-link.ts", tools: [] }] },
        { cwd: project, projectTrusted: false, coreTools: [] },
      ),
    /project.*not trusted/i,
  );
  assert.throws(
    () =>
      resolveResourceAttachments(
        { extensions: [{ path: projectLink, tools: [] }] },
        { cwd: project, projectTrusted: false, coreTools: [] },
      ),
    /project.*not trusted/i,
  );
});

test("rejects remote, missing, invalid, and oversized attachment inputs", () => {
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
  ];

  for (const { value, error } of invalidInputs) {
    assert.throws(
      () => resolveResourceAttachments(value, { cwd: project, projectTrusted: true, coreTools: [] }),
      error,
    );
  }

  assert.throws(
    () =>
      resolveResourceAttachments(
        { skills: Array.from({ length: MAX_ATTACHED_SKILLS + 1 }, () => regularFile) },
        { cwd: project, projectTrusted: true, coreTools: [] },
      ),
    new RegExp(`at most ${MAX_ATTACHED_SKILLS}`, "i"),
  );
  assert.throws(
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
  assert.throws(
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

test("rejects unsupported filesystem object types", { skip: process.platform === "win32" }, () => {
  const fifoPath = path.join(external, "fifo");
  const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.throws(
    () => resolveResourceAttachments({ skills: [fifoPath] }, { cwd: project, projectTrusted: true, coreTools: [] }),
    /file or directory/i,
  );
});
