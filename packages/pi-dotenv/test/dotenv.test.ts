import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import registerDotenvExtension, { loadEnvFile, resolveEnvFileArgument } from "../src/dotenv.js";

const EXTENSION_ENTRY = resolve(process.cwd(), "packages/pi-dotenv/src/index.ts");

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-dotenv-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withProcessState(names: string[], run: () => Promise<void> | void): Promise<void> {
  const argv = [...process.argv];
  const values = new Map(names.map((name) => [name, process.env[name]]));
  try {
    await run();
  } finally {
    process.argv = argv;
    for (const [name, value] of values) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

test("registers the flag and loads the file before the factory returns", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "factory.env");
    const variable = "PI_DOTENV_FACTORY_TEST";
    await writeFile(path, `${variable}=factory-loaded\n`);

    await withProcessState([variable], () => {
      delete process.env[variable];
      process.argv = [process.execPath, "pi", "--env-file", path];
      let registered: { name: string; options: unknown } | undefined;

      registerDotenvExtension({
        registerFlag(name: string, options: unknown) {
          registered = { name, options };
        },
      } as never);

      assert.deepEqual(registered, {
        name: "env-file",
        options: {
          description: "Load missing environment variables from a dotenv file",
          type: "string",
        },
      });
      assert.equal(process.env[variable], "factory-loaded");
    });
  });
});

test("loads through DefaultResourceLoader and remains idempotent across reload", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent");
    const path = join(root, "reload.env");
    const variable = "PI_DOTENV_RELOAD_TEST";
    await writeFile(path, `${variable}=first\n`);

    await withProcessState(["PI_CODING_AGENT_DIR", variable], async () => {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env[variable];
      process.argv = [process.execPath, "pi", "--env-file", path];
      const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        additionalExtensionPaths: [EXTENSION_ENTRY],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.ok(loader.getExtensions().extensions[0]?.flags.has("env-file"));
      assert.equal(process.env[variable], "first");

      await writeFile(path, `${variable}=second\n`);
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.equal(process.env[variable], "first");
    });
  });
});

test("reports an unreadable file as an extension error without exposing values or paths", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent");
    const secretPath = join(root, "do-not-print-this-secret.env");

    await withProcessState(["PI_CODING_AGENT_DIR"], async () => {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.argv = [process.execPath, "pi", "--env-file", secretPath];
      const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        additionalExtensionPaths: [EXTENSION_ENTRY],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      await loader.reload();
      const errors = loader.getExtensions().errors;
      assert.equal(errors.length, 1);
      assert.match(errors[0]?.error ?? "", /Could not read the file passed to --env-file/);
      assert.doesNotMatch(errors[0]?.error ?? "", /do-not-print-this-secret/);
    });
  });
});

test("publishes a provider key before Pi's post-extension availability refresh", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent");
    const path = join(root, "provider.env");
    await writeFile(path, "OPENAI_API_KEY=pi-dotenv-fake-provider-key\n");

    await withProcessState(["PI_CODING_AGENT_DIR", "OPENAI_API_KEY"], async () => {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env.OPENAI_API_KEY;
      const { createAgentSessionServices, SettingsManager } = await import("@earendil-works/pi-coding-agent");
      const commonOptions = {
        cwd: root,
        agentDir,
        modelRuntimeSignal: AbortSignal.timeout(4_000),
      };

      const baseline = await createAgentSessionServices({
        ...commonOptions,
        settingsManager: SettingsManager.inMemory(),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      assert.equal((await baseline.modelRuntime.getAvailable("openai")).length, 0);

      process.argv = [process.execPath, "pi", "--env-file", path];
      const loaded = await createAgentSessionServices({
        ...commonOptions,
        settingsManager: SettingsManager.inMemory(),
        resourceLoaderOptions: {
          additionalExtensionPaths: [EXTENSION_ENTRY],
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });

      assert.deepEqual(loaded.resourceLoader.getExtensions().errors, []);
      assert.ok((await loaded.modelRuntime.getAvailable("openai")).length > 0);
    });
  });
});
