import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadEnvFile, resolveEnvFileArgument } from "../src/dotenv.js";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-dotenv-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const argumentCases: Array<{ name: string; args: string[]; expected: string | undefined }> = [
  { name: "absent", args: ["--model", "gpt-5"], expected: undefined },
  { name: "spaced value", args: ["--env-file", ".env"], expected: ".env" },
  { name: "equals value", args: ["--env-file=config/dev.env"], expected: "config/dev.env" },
  {
    name: "last occurrence",
    args: ["--env-file", "first.env", "--env-file=second.env"],
    expected: "second.env",
  },
  {
    name: "later valid occurrence replaces a missing one",
    args: ["--env-file", "--verbose", "--env-file", "valid.env"],
    expected: "valid.env",
  },
  {
    name: "terminator ignores later occurrences",
    args: ["--env-file", "active.env", "--", "--env-file", "ignored.env"],
    expected: "active.env",
  },
  {
    name: "equals form accepts a dash-prefixed path",
    args: ["--env-file=--local.env"],
    expected: "--local.env",
  },
  {
    name: "Pi option values are not reinterpreted as extension flags",
    args: ["--system-prompt", "--env-file", ".env"],
    expected: undefined,
  },
];

for (const { name, args, expected } of argumentCases) {
  test(`resolves ${name}`, () => {
    assert.equal(resolveEnvFileArgument(args), expected);
  });
}

const invalidArgumentCases = [
  ["--env-file"],
  ["--env-file="],
  ["--env-file", ""],
  ["--env-file", "-invalid.env"],
  ["--env-file", "@prompt.env"],
  ["--env-file", "valid.env", "--env-file"],
];

for (const args of invalidArgumentCases) {
  test(`rejects an invalid final env-file occurrence: ${JSON.stringify(args)}`, () => {
    assert.throws(() => resolveEnvFileArgument(args), /--env-file requires a path/);
  });
}

test("loads parsed values atomically while preserving the existing environment", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "values.env");
    await writeFile(
      path,
      [
        "# ignored comment",
        "PI_DOTENV_NEW=from-file",
        "PI_DOTENV_EXISTING=from-file",
        'PI_DOTENV_QUOTED="hello world"',
        "PI_DOTENV_EMPTY=",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { PI_DOTENV_EXISTING: "from-shell" };

    const parsed = loadEnvFile(path, { env });

    assert.deepEqual(parsed, {
      PI_DOTENV_NEW: "from-file",
      PI_DOTENV_EXISTING: "from-file",
      PI_DOTENV_QUOTED: "hello world",
      PI_DOTENV_EMPTY: "",
    });
    assert.deepEqual(env, {
      PI_DOTENV_NEW: "from-file",
      PI_DOTENV_EXISTING: "from-shell",
      PI_DOTENV_QUOTED: "hello world",
      PI_DOTENV_EMPTY: "",
    });
  });
});

test("strips a UTF-8 BOM from the first variable name", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "bom.env");
    await writeFile(path, "\uFEFFOPENAI_API_KEY=sk-dummy\nSECOND=yes\n");
    const env: NodeJS.ProcessEnv = {};

    const parsed = loadEnvFile(path, { env });

    assert.deepEqual(parsed, { OPENAI_API_KEY: "sk-dummy", SECOND: "yes" });
    assert.equal(env.OPENAI_API_KEY, "sk-dummy");
    assert.equal(env["\uFEFFOPENAI_API_KEY"], undefined);
  });
});

test("resolves relative paths from the supplied working directory", async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, ".env.local"), "PI_DOTENV_RELATIVE=loaded\n");
    const env: NodeJS.ProcessEnv = {};

    loadEnvFile(".env.local", { cwd: root, env });

    assert.equal(env.PI_DOTENV_RELATIVE, "loaded");
  });
});

test("does not mutate the environment when the selected file is unreadable", async () => {
  await withTempDir(async (root) => {
    const env: NodeJS.ProcessEnv = { PI_DOTENV_STABLE: "before" };

    assert.throws(
      () => loadEnvFile(join(root, "missing-secret-name.env"), { env }),
      /^Error: Could not read the file passed to --env-file$/,
    );
    assert.deepEqual(env, { PI_DOTENV_STABLE: "before" });
  });
});
