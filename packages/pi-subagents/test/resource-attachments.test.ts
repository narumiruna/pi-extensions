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
