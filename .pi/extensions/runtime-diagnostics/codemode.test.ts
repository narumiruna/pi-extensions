import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const fauxSpecifier = "@earendil-works/pi-ai/providers/faux";

for (const mode of ["on", "only"] as const) {
  test(`returns structured diagnostics through native codemode in ${mode} mode`, async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-diagnostics-codemode-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      process.env.PI_CODING_AGENT_DIR = root;
      const fauxModule = (await import(fauxSpecifier)) as typeof import("@earendil-works/pi-ai/providers/faux");
      const faux = fauxModule.createFauxCore({
        api: `diagnostics-${crypto.randomUUID()}`,
        provider: `diagnostics-${crypto.randomUUID()}`,
        models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 4_000 }],
        tokensPerSecond: Infinity,
      });
      faux.setResponses([
        fauxModule.fauxAssistantMessage(
          fauxModule.fauxToolCall("codemode", {
            code: `
              const declaration = await describeTool("runtime_diagnostics");
              if (!declaration || !declaration.includes("summary:") || !declaration.includes("outputNote?:")) throw new Error("Missing output schema");
              const status = await tools.runtime_diagnostics({});
              if (status.format !== "runtime-diagnostics/v2" || !status.summary) throw new Error("Not structured");
              const targeted = await tools.runtime_diagnostics({ sections: ["provider", "privacy"] });
              if (!targeted.details.providerRequestCapture || !targeted.details.privacy.passed) throw new Error("Missing sections");
              const bundle = await tools.runtime_diagnostics({ action: "bundle" });
              if (!bundle.export.sanitized || JSON.stringify(bundle).includes(${JSON.stringify(process.cwd())})) throw new Error("Unsafe bundle");
              const configured = await tools.runtime_diagnostics({ action: "configure", maxRecords: 2 });
              if (configured.summary.capture.policy.maxRecords !== 2) throw new Error("Control failed");
              let rejected = false;
              try { await tools.runtime_diagnostics({ action: "configure" }); }
              catch (error) { rejected = String(error).includes("requires maxRecords or maxAgeMinutes"); }
              if (!rejected) throw new Error("Control error did not reject");
              text({ structured: true, sections: Object.keys(targeted.details), sanitized: bundle.export.sanitized });
            `,
          }),
        ),
        fauxModule.fauxAssistantMessage("done"),
      ]);
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
      const registry = new ModelRegistry(runtime);
      registry.registerProvider(faux.provider, {
        api: faux.api,
        apiKey: "local-fixture",
        baseUrl: "http://localhost",
        streamSimple: faux.streamSimple,
        models: faux.models,
      });
      const model = registry.find(faux.provider, "fixture");
      assert.ok(model);
      const settingsManager = SettingsManager.inMemory({
        defaultTools: ["+codemode"],
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const entrypoint = resolve(".pi/extensions/runtime-diagnostics/index.ts");
      if (mode === "only") {
        const extensionsDir = join(root, ".pi", "extensions");
        await mkdir(extensionsDir, { recursive: true });
        await symlink(
          resolve(".pi/extensions/runtime-diagnostics"),
          join(extensionsDir, "runtime-diagnostics"),
          "junction",
        );
        settingsManager.setProjectTrusted(true);
      }
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager,
        noExtensions: mode === "on",
        noSkills: true,
        noContextFiles: true,
        additionalExtensionPaths: [...(mode === "on" ? [entrypoint] : []), "builtin:codemode"],
        extensionFactories: [
          { name: "codemode", builtin: true, factory: createCodemodeExtension({ mode, models: false }) },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        modelRuntime: runtime,
        model,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
      }));
      const errors: unknown[] = [];
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      await session.reload();
      await session.prompt("Inspect structured diagnostics through codemode.");
      const result = session.agent.state.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "codemode",
      );
      assert.ok(result?.role === "toolResult");
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.match(JSON.stringify(result.content), /\\"structured\\":true/);
      assert.match(JSON.stringify(result.content), /\\"sanitized\\":true/);
      assert.deepEqual(errors, []);
    } finally {
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
