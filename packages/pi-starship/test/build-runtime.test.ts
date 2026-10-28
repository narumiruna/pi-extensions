import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionCommandContext,
  type ExtensionContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { listFiles, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";
import { response, settingsChatCustom, testModel } from "./settings-chat-support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-starship",
  forbiddenEagerInputs: [
    "src/commands.ts",
    "src/command-configuration-menu.ts",
    "src/command-preset-picker.ts",
    "src/command-preview.ts",
    "src/command-profiles.ts",
    "src/profile-store.ts",
    "src/command-commit.ts",
    "src/command-settings-chat.ts",
    "src/settings-agent.ts",
    "src/settings-chat-ui.ts",
    "src/settings-chat-transcript.ts",
    "src/settings-draft.ts",
    "src/settings-snapshots.ts",
    "src/presets/catalog.ts",
    "src/runtime/cloud.ts",
    "src/runtime/deployment.ts",
    "src/runtime/development.ts",
    "src/runtime/execution.ts",
    "src/runtime/languages.ts",
    "src/runtime/package.ts",
  ],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit", "@earendil-works/pi-agent-core", "yaml"],
  matchExternalSubpaths: false,
  includeDynamicExternals: true,
});

test("generated command registration maps to the authoritative source", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-starship-build-test-"));
  try {
    const first = join(root, "first");
    await builder.buildRuntime({ outputDirectory: first });

    const entrySource = await readFile(join(first, "index.ts"), "utf8");
    const generatedLine = entrySource.split("\n").findIndex((line) => line.includes('pi.registerCommand("starship"'));
    assert.notEqual(generatedLine, -1);
    const sourceMap = new SourceMap(JSON.parse(await readFile(join(first, "index.ts.map"), "utf8")));
    const mapped = sourceMap.findEntry(generatedLine, 0);
    assert.ok("originalSource" in mapped, "expected generated entry to map to source");
    assert.match(mapped.originalSource ?? "", /src\/pi-starship\.ts$/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime refuses to resolve a package at call time", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-starship-build-test-"));
  try {
    const output = join(root, "dist");
    await builder.buildRuntime({ outputDirectory: output });
    await assert.doesNotReject(builder.validateGeneratedFiles(output));

    // What `createRequire(import.meta.url)` compiles to. A compiled Pi binary
    // resolves the package it returns against the binary's embedded graph
    // rather than the directory the package was installed into, so the package
    // is not found there (#1307). The bundler renames the binding, so the
    // factory call is what the gate looks for.
    const chunkName = (await listFiles(output)).find((path) => path.startsWith("chunks/") && path.endsWith(".ts"));
    assert.ok(chunkName);
    const chunkPath = join(output, chunkName);
    const chunkSource = await readFile(chunkPath, "utf8");
    await writeFile(
      chunkPath,
      `${chunkSource}\nvar require2 = createRequire(import.meta.url);\nvar late = require2("smol-toml");\n`,
      "utf8",
    );
    await assert.rejects(
      builder.validateGeneratedFiles(output),
      new RegExp(`resolves a package at call time in ${chunkName.replace(".", "\\.")}`, "u"),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-starship-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    // The settings file is the representative boundary: reading it is the only
    // thing the runtime needs an external package for.
    await writeFile(
      join(agentDir, "pi-starship.toml"),
      'format = "[theme](pi:accent)$directory"\n[directory]\nstyle = "fg:pi:selectedBg bg:pi:accent"\n',
      "utf8",
    );
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
    assert.ok(extension?.commands.has("starship"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));
    assert.ok(extension);
    loaded.runtime.getThinkingLevel = () => "off";
    const tui = createTuiHarness({ width: 80, rows: 24 });
    let fullscreen: Parameters<NonNullable<Parameters<typeof settingsChatCustom>[2]>>[0] | undefined;
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: settingsChatCustom(tui.custom, undefined, (value) => {
        fullscreen = value;
      }),
    });
    const emit = async (name: "session_start" | "session_shutdown" | "session_tree") => {
      const event = name === "session_start" ? { type: name, reason: "startup" } : { type: name };
      for (const handler of extension.handlers.get(name) ?? []) await handler(event, context.ctx as ExtensionContext);
    };
    await emit("session_start");
    try {
      const command = extension.commands.get("starship");
      assert.ok(command);
      await command.handler("status", { ...(context.ctx as ExtensionCommandContext), mode: "rpc" });
      assert.match(context.notifications.at(-1)?.message ?? "", /source: user[\s\S]*warnings: none/u);
      // Exercise the generated menu, summary, profile, chat, and snapshot chunks through Jiti.
      const running = command.handler("", context.ctx);
      try {
        await tui.waitForOpen();
        for (let index = 0; index < 3; index++) tui.press("tui.select.down");
        tui.press("tui.select.confirm");
        await tui.waitForOpen();
        const configurationFrame = tui.render().join("\n");
        assert.match(configurationFrame, /Source: User file/u);
        assert.match(configurationFrame, /→ Reload from disk/u);
        assert.doesNotMatch(configurationFrame, /Overview|Effective configuration|Settings document/u);
        tui.press("tui.select.cancel");
        await tui.waitForOpen();
        tui.press("tui.select.up");
        assert.match(tui.render().join("\n"), /→ Profiles/u);
        tui.press("tui.select.confirm");
        await tui.waitForOpen();
        const profileFrame = tui.render().join("\n");
        tui.press("ctrl+c");
        await running;
        assert.match(profileFrame, /Profiles/u);
        assert.match(profileFrame, /Save current/u);

        const ctx = context.ctx as ExtensionCommandContext;
        ctx.model = { ...testModel, input: ["text"] };
        let skillLoaded = false;
        let snapshotRead = false;
        let requests = 0;
        ctx.modelRegistry.streamSimple = (_model, request) => {
          requests += 1;
          const system = request.messages[0];
          skillLoaded =
            system?.role === "system" &&
            typeof system.content === "string" &&
            system.content.includes("# Configure pi-starship");
          if (requests === 1) {
            const prompt = system?.role === "system" && typeof system.content === "string" ? system.content : "";
            const directory = /Tool working directory: ([^\n]+)/u.exec(prompt)?.[1] ?? "";
            return response(
              [
                {
                  type: "toolCall",
                  id: "snapshot",
                  name: "read",
                  arguments: { path: join(directory, "active-state.json") },
                },
              ],
              "toolUse",
            );
          }
          snapshotRead = request.messages.some(
            (message) =>
              message.role === "toolResult" &&
              !message.isError &&
              JSON.stringify(message.content).includes("loadedDocumentAvailable"),
          );
          return response([
            {
              type: "text",
              text: `Generated chat ready\n${Array.from({ length: 120 }, (_, row) => `generated-row-${row}`).join("\n")}`,
            },
          ]);
        };
        const chat = command.handler("", ctx);
        await tui.waitForOpen();
        tui.press("tui.select.confirm");
        await tui.waitForOpen();
        const chatFrame = tui.render().join("\n");
        tui.type("Explain the model module");
        tui.send("\r");
        await tui.waitForPending();
        assert.match(tui.render().join("\n"), /generated-row-119/u);
        tui.send("\x1b[5~");
        const paged = tui.render().join("\n");
        assert.doesNotMatch(paged, /generated-row-119/u);
        tui.mouse({ type: "wheel", x: 1, y: 1, wheelDelta: -1 });
        assert.notEqual(tui.render().join("\n"), paged);
        tui.press("ctrl+c");
        await chat;
        assert.match(chatFrame, /─ pi-starship /u);
        assert.equal(skillLoaded, true);
        assert.equal(snapshotRead, true);

        // A tree transition invalidates context but keeps the same physical TUI.
        const treeChat = command.handler("", ctx);
        await tui.waitForOpen();
        tui.press("tui.select.confirm");
        await tui.waitForOpen();
        assert.ok(fullscreen);
        const restart = vi.spyOn(fullscreen.parent, "start");
        await emit("session_tree");
        await treeChat;
        assert.equal(restart.mock.calls.length, 1);
        restart.mockRestore();

        // The real extension shutdown hook must join the child's terminal drain,
        // not only the already-idle configuration agent.
        const secondChat = command.handler("", ctx);
        await tui.waitForOpen();
        tui.press("tui.select.confirm");
        await tui.waitForOpen();
        assert.ok(fullscreen);
        let release!: () => void;
        let draining!: () => void;
        const drainStarted = new Promise<void>((resolve) => {
          draining = resolve;
        });
        fullscreen.terminal.drain = () =>
          new Promise<void>((resolve) => {
            release = resolve;
            draining();
          });
        let stopped = false;
        const shutdown = emit("session_shutdown").then(() => {
          stopped = true;
        });
        await drainStarted;
        assert.equal(stopped, false);
        release();
        await shutdown;
        await secondChat;
        assert.equal(stopped, true);
      } finally {
        tui.dispose();
        await running;
      }
    } finally {
      await emit("session_shutdown");
      loaded.runtime.invalidate("generated profile smoke complete");
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
