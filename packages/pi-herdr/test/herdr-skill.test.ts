import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const skillUrl = new URL("../skills/herdr/SKILL.md", import.meta.url);

async function readSkill(): Promise<string> {
  return readFile(skillUrl, "utf8");
}

test("bootstraps the authoritative skill through one guarded shell call", async () => {
  const skill = await readSkill();
  for (const contract of [
    "Before the first Herdr control command in a session",
    `test "\${HERDR_ENV:-}" = 1`,
    "herdr --skill",
    "If the environment check or command fails, report the error and stop.",
    "authoritative operating instructions for the installed Herdr version",
  ]) {
    assert.ok(skill.includes(contract), `missing bootstrap contract: ${contract}`);
  }
});

test("reuses retained guidance without duplicating Herdr command recipes", async () => {
  const skill = await readSkill();
  assert.match(skill, /If it is present, reuse it and do not load it again\./u);
  assert.match(
    skill,
    /Run it again only after compaction removes those instructions or when the user explicitly asks to refresh them\./u,
  );
  assert.deepEqual(
    skill.split("\n").filter((line) => line.startsWith("herdr ")),
    ["herdr --skill"],
  );
});
