import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const skillUrl = new URL("../skills/hc/SKILL.md", import.meta.url);

async function readSkill(): Promise<string> {
  return readFile(skillUrl, "utf8");
}

test("the package discovers hc alongside the retained herdr skill without diagnostics", async () => {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    pi: { skills: string[] };
  };
  const result = loadSkills({
    cwd: packageDir,
    agentDir: packageDir,
    skillPaths: manifest.pi.skills.map((path) => resolve(packageDir, path)),
    includeDefaults: false,
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.skills.map(({ name }) => name).sort(), ["hc", "herdr"]);
  const hc = result.skills.find(({ name }) => name === "hc");
  assert.ok(hc);
  assert.equal(hc.filePath, fileURLToPath(skillUrl));
  assert.match(hc.description, /Use only when the user explicitly mentions hc, Herdr Core, or herdr-core/u);
  assert.match(hc.description, /Do not use merely because a task could benefit from/u);
});

test("hc bootstraps complete CLI-owned guidance and reuses it without copied command recipes", async () => {
  const skill = await readSkill();
  for (const contract of [
    "It does not require a Herdr-managed pane or `HC_TERMINAL_ID`.",
    "Before the first hc control command in a session",
    "If it is present, reuse it and do not load it again.",
    "If the CLI is unavailable or the command fails, report the error and stop without falling back to `herdr`.",
    "authoritative operating instructions for the installed Herdr Core version",
    "If the output is truncated, retrieve the complete guidance before running a control command.",
    "Run it again only after compaction removes those instructions or when the user explicitly asks to refresh them.",
  ]) {
    assert.ok(skill.includes(contract), `missing bootstrap contract: ${contract}`);
  }
  assert.deepEqual(
    [...skill.matchAll(/```bash\n([\s\S]*?)\n```/gu)].map((match) => match[1]),
    ["hc --skill"],
  );
  assert.deepEqual(
    skill.split("\n").filter((line) => /^(?:hc|herdr) /u.test(line)),
    ["hc --skill"],
  );
});

test.skipIf(process.platform === "win32").each([
  { label: "without Herdr or parent-terminal variables", hcExit: 0, expectedStatus: 0, env: {} },
  { label: "inside a legacy Herdr pane", hcExit: 0, expectedStatus: 0, env: { HERDR_ENV: "1" } },
  { label: "when hc fails", hcExit: 42, expectedStatus: 42, env: {} },
  { label: "when hc is missing", hcExit: undefined, expectedStatus: 127, env: { HERDR_ENV: "1" } },
])("hc bootstrap preserves the CLI result $label", async ({ hcExit, expectedStatus, env }) => {
  const skill = await readSkill();
  const script = skill.match(/```bash\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(script);
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-hc-skill-"));
  try {
    if (hcExit !== undefined) {
      await writeFile(
        join(root, "hc"),
        `#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = --skill ] || exit 91\n${
          hcExit === 0
            ? "printf '%s\\n' 'CLI-owned hc guidance' 'Complete second line'"
            : "printf '%s\\n' 'hc skill failed' >&2"
        }\nexit ${hcExit}\n`,
        { mode: 0o755 },
      );
    }
    await writeFile(join(root, "herdr"), "#!/bin/sh\nprintf '%s\\n' 'wrong CLI fallback'\n", { mode: 0o755 });
    const result = spawnSync("/bin/sh", ["-c", script], {
      cwd: root,
      env: { PATH: root, ...env },
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(result.stdout, expectedStatus === 0 ? "CLI-owned hc guidance\nComplete second line\n" : "");
    if (expectedStatus === 0) assert.equal(result.stderr, "");
    else assert.match(result.stderr, /hc/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
