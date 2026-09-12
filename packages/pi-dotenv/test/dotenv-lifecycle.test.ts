import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, vi } from "vitest";

const EXTENSION_ENTRY = resolve(process.cwd(), "packages/pi-dotenv/src/index.ts");

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-dotenv-lifecycle-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withProcessState(names: string[], run: () => Promise<void>): Promise<void> {
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

async function importPiWithAgentDir(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("@earendil-works/pi-coding-agent");
}

test("loads through DefaultResourceLoader and remains idempotent across reload", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent");
    const path = join(root, "reload.env");
    const variable = "PI_DOTENV_RELOAD_TEST";
    await writeFile(path, `${variable}=first\n`);

    await withProcessState(["PI_CODING_AGENT_DIR", variable], async () => {
      delete process.env[variable];
      process.argv = [process.execPath, "pi", "--env-file", path];
      const { DefaultResourceLoader, SettingsManager } = await importPiWithAgentDir(agentDir);
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
      const flag = loader.getExtensions().extensions[0]?.flags.get("env-file");
      assert.equal(flag?.type, "string");
      assert.equal(flag?.description, "Load missing environment variables from a dotenv file");
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
      process.argv = [process.execPath, "pi", "--env-file", secretPath];
      const { DefaultResourceLoader, SettingsManager } = await importPiWithAgentDir(agentDir);
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
      delete process.env.OPENAI_API_KEY;
      const { createAgentSessionServices, SettingsManager } = await importPiWithAgentDir(agentDir);
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
