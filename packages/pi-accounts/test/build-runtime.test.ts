import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-accounts",
  forbiddenEagerInputs: ["src/account-menu.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-accounts-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("accounts"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    const notifications: string[] = [];
    const sessionId = "generated-session";
    const ctx = {
      hasUI: false,
      model: undefined,
      modelRegistry: {},
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-accounts-selection",
            data: {
              version: 1,
              sessionId,
              providers: {
                anthropic: null,
                "github-copilot": null,
                "kimi-coding": null,
                "openai-codex": null,
                openrouter: null,
                radius: null,
                xai: null,
              },
            },
          },
        ],
      },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    };
    const command = extension?.commands.get("accounts");
    assert.ok(command);
    await command.handler("", ctx as never);
    assert.match(notifications.at(-1) ?? "", /requires interactive UI/iu);

    const accountsFile = join(agentDir, "pi-accounts.json");
    await writeFile(
      accountsFile,
      JSON.stringify({
        version: 1,
        providers: {
          "openai-codex": {
            accounts: {
              work: {
                type: "oauth",
                access: "fixture-access",
                refresh: "fixture-refresh",
                expires: 2_000_000_000_000,
              },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const choices = ["Set default account", "OpenAI Codex", "work"];
    await command.handler("", {
      ...ctx,
      mode: "rpc",
      hasUI: true,
      ui: { ...ctx.ui, select: async () => choices.shift() },
    } as never);
    assert.equal(choices.length, 0);
    assert.equal(JSON.parse(await readFile(accountsFile, "utf8")).providers["openai-codex"].active, "work");
    assert.match(notifications.at(-1) ?? "", /new sessions: work.*unchanged/u);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
