import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { resolveResourceAttachments } from "../src/resource-attachments.js";

const failure = vi.hoisted(() => ({ directory: "", phase: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    async realpath(...args: Parameters<typeof filesystem.realpath>) {
      if (args[0] === failure.directory && failure.phase === "realpath") throw new Error("simulated directory failure");
      return filesystem.realpath(...args);
    },
    async opendir(...args: Parameters<typeof filesystem.opendir>) {
      const [directory] = args;
      if (directory === failure.directory && failure.phase === "open") throw new Error("simulated directory failure");
      const handle = await filesystem.opendir(...args);
      if (directory !== failure.directory || failure.phase !== "read") return handle;
      const iterator = handle[Symbol.asyncIterator]();
      return {
        async *[Symbol.asyncIterator]() {
          try {
            const first = await iterator.next();
            if (!first.done) yield first.value;
            throw new Error("simulated directory failure");
          } finally {
            await iterator.return?.();
          }
        },
      } as typeof handle;
    },
  };
});

let root: string;
let project: string;
let packageDirectory: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-read-errors-"));
  project = path.join(root, "project");
  packageDirectory = path.join(root, "package");
  mkdirSync(project);
  mkdirSync(path.join(packageDirectory, "extensions"), { recursive: true });
  mkdirSync(path.join(packageDirectory, "prompts"));
  writeFileSync(path.join(packageDirectory, "extensions", "valid.ts"), "export default () => {};\n");
  writeFileSync(path.join(packageDirectory, "prompts", "draft.md"), "Draft.\n");
});

afterEach(() => {
  failure.directory = "";
  failure.phase = "";
  rmSync(root, { recursive: true, force: true });
});

for (const phase of ["realpath", "open", "read"]) {
  test(`ignores optional resource directory ${phase} failures`, async () => {
    failure.directory = path.join(packageDirectory, "prompts");
    failure.phase = phase;
    const resolved = await resolveResourceAttachments(
      { extensions: [{ path: packageDirectory, tools: [] }] },
      { cwd: project, projectTrusted: true, coreTools: [] },
    );
    assert.deepEqual(resolved.extensions, [{ path: packageDirectory, tools: [] }]);
  });

  test(`rejects declared skill directory ${phase} failures`, async () => {
    const skillsDirectory = path.join(packageDirectory, "skills");
    mkdirSync(skillsDirectory);
    writeFileSync(path.join(skillsDirectory, "SKILL.md"), "---\nname: declared\ndescription: Valid skill.\n---\n");
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ pi: { extensions: ["./extensions/valid.ts"], skills: ["./skills"] } }),
    );
    failure.directory = skillsDirectory;
    failure.phase = phase;
    await assert.rejects(
      () =>
        resolveResourceAttachments(
          { extensions: [{ path: packageDirectory, tools: [] }] },
          { cwd: project, projectTrusted: true, coreTools: [] },
        ),
      /unreadable declared skill directory/i,
    );
  });

  test(`rejects convention skill directory ${phase} failures`, async () => {
    const skillsDirectory = path.join(packageDirectory, "skills");
    mkdirSync(skillsDirectory);
    writeFileSync(path.join(skillsDirectory, "SKILL.md"), "---\nname: convention\ndescription: Valid skill.\n---\n");
    failure.directory = skillsDirectory;
    failure.phase = phase;
    await assert.rejects(
      () =>
        resolveResourceAttachments(
          { extensions: [{ path: packageDirectory, tools: [] }] },
          { cwd: project, projectTrusted: true, coreTools: [] },
        ),
      /unreadable declared skill directory/i,
    );
  });
}

for (const phase of ["open", "read"]) {
  test(`rejects required extension directory ${phase} failures`, async () => {
    failure.directory = path.join(packageDirectory, "extensions");
    failure.phase = phase;
    await assert.rejects(
      () =>
        resolveResourceAttachments(
          { extensions: [{ path: packageDirectory, tools: [] }] },
          { cwd: project, projectTrusted: true, coreTools: [] },
        ),
      /missing or unresolvable declared entrypoint/i,
    );
  });
}
