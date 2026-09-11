import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { explicitSkillName, SkillTracker } from "../src/skills.js";

test("explicit skill parsing accepts exact commands with arguments", () => {
  assert.equal(explicitSkillName("/skill:reviewing-code"), "reviewing-code");
  assert.equal(explicitSkillName("/skill:reviewing-code inspect this"), "reviewing-code");
  assert.equal(explicitSkillName(" /skill:reviewing-code"), undefined);
  assert.equal(explicitSkillName("/skill:Reviewing-Code"), undefined);
  assert.equal(explicitSkillName("/skill:reviewing-code!"), undefined);
  assert.equal(explicitSkillName("hello /skill:reviewing-code"), undefined);
});

test("pending explicit skill is replaced by later ordinary user input and ignores extension input", () => {
  const tracker = new SkillTracker("/workspace");
  tracker.observeInput("/skill:reviewing-code", "interactive", 1);
  tracker.observeInput("extension note", "extension", 2);
  assert.equal(tracker.consumeExplicitSkill()?.name, "reviewing-code");
  tracker.observeInput("/skill:applying-tdd", "rpc", 3);
  tracker.observeInput("normal user prompt", "interactive", 4);
  assert.equal(tracker.consumeExplicitSkill(), undefined);
});

test("successful canonical built-in reads match discovered skill paths", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-skills-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const skillDirectory = path.join(directory, "skills", "review");
  await mkdir(skillDirectory, { recursive: true });
  const file = path.join(skillDirectory, "SKILL.md");
  await writeFile(file, "---\nname: reviewing-code\n---\n");
  const alias = path.join(directory, "alias.md");
  await symlink(file, alias);
  const tracker = new SkillTracker(directory);
  await tracker.setAvailableSkills([{ name: "reviewing-code", filePath: file }]);

  assert.equal(
    await tracker.matchSuccessfulRead({ toolName: "read", input: { path: alias }, isError: false }),
    "reviewing-code",
  );
  assert.equal(
    await tracker.matchSuccessfulRead({
      toolName: "read",
      input: { path: `@${path.relative(directory, file)}` },
      isError: false,
    }),
    "reviewing-code",
  );
  assert.equal(
    await tracker.matchSuccessfulRead({ toolName: "read", input: { path: file }, isError: true }),
    undefined,
  );
  assert.equal(
    await tracker.matchSuccessfulRead({ toolName: "bash", input: { path: file }, isError: false }),
    undefined,
  );
});

test("colliding names retain Pi's first discovered canonical path", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-collision-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, "first.md");
  const second = path.join(directory, "second.md");
  await writeFile(first, "first");
  await writeFile(second, "second");
  const tracker = new SkillTracker(directory);
  await tracker.setAvailableSkills([
    { name: "same", filePath: first },
    { name: "same", filePath: second },
  ]);
  assert.equal(await tracker.matchSuccessfulRead({ toolName: "read", input: { path: first }, isError: false }), "same");
  assert.equal(
    await tracker.matchSuccessfulRead({
      toolName: "read",
      input: { path: second },
      isError: false,
    }),
    undefined,
  );
});
