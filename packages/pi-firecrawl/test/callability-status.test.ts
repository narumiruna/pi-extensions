import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";

const capabilities = [
  "firecrawl_scrape",
  "firecrawl_crawl",
  "firecrawl_crawl_status",
  "firecrawl_map",
  "firecrawl_search",
] as const;
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-firecrawl-callability-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

for (const exposure of ["direct", "model-only", "codemode", "deferred", "hidden"] as const) {
  for (const active of [false, true]) {
    test(`status separates ${exposure} callability from ${active ? "active" : "inactive"} declarations`, async () => {
      await fixture(async () => {
        const { default: extension } = await import("../src/firecrawl.js");
        const { buildStatusMessage } = await import("../src/tool-selector.js");
        const mock = createMockPi({ activeTools: ["codemode"] });
        const { ctx } = createMockContext();
        extension(mock.pi);
        await mock.events.get("session_start")?.[0]?.({}, ctx);
        const tool = mock.tools.find((entry) => entry.name === capabilities[0]);
        assert.ok(tool);
        mock.rawPi.getAllTools = () => [{ ...tool, exposure: exposure as ToolExposure }];
        mock.rawPi.getActiveTools = () => (active ? ["codemode", capabilities[0]] : ["codemode"]);
        const callable = exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active);
        const status = await buildStatusMessage(mock.pi);
        assert.match(status, /enabled \(5\/5 available\)/);
        assert.ok(status.includes(`Callable capability tools: ${callable ? 1 : 0}/5`));
      });
    });
  }
}

for (const toolMode of ["codemode", "direct", "lazy"] as const) {
  for (const host of [
    "unrestricted",
    "filtered-all",
    "allow-one",
    "exclude-one",
    "only-capability",
    "disabled-capability",
    "default-capability",
  ] as const) {
    test(`real Jiti ${toolMode} status matches effective callability under ${host}`, async () => {
      await fixture(async (root) => {
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const original = JSON.stringify({
            tools: host === "disabled-capability" ? capabilities.slice(1) : capabilities,
            toolMode,
            updatedAt: 1,
          });
          await writeFile(join(root, "pi-firecrawl.json"), original);
          const settingsManager = SettingsManager.inMemory({
            defaultTools: host === "default-capability" ? [capabilities[0]] : ["+codemode"],
          });
          const builtinsSpecifier = new URL(
            "extensions/index.js",
            import.meta.resolve("@earendil-works/pi-coding-agent"),
          ).href;
          const { builtInExtensions } = (await import(builtinsSpecifier)) as { builtInExtensions: InlineExtension[] };
          const loader = new DefaultResourceLoader({
            cwd: root,
            agentDir: root,
            settingsManager,
            extensionFactories: builtInExtensions,
            noExtensions: true,
            noSkills: true,
            noContextFiles: true,
            additionalExtensionPaths: ["builtin:codemode", resolve("packages/pi-firecrawl")],
          });
          await loader.reload();
          assert.deepEqual(loader.getExtensions().errors, []);
          const modelRuntime = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsPath: null,
          });
          const created = await createAgentSession({
            cwd: root,
            agentDir: root,
            modelRuntime,
            settingsManager,
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(root),
            ...(host === "filtered-all" ? { tools: ["read", "bash", "codemode"] } : {}),
            ...(host === "allow-one" ? { tools: ["read", "bash", "codemode", capabilities[0], "firecrawl_load"] } : {}),
            ...(host === "exclude-one" ? { excludeTools: [capabilities[0]] } : {}),
            ...(["only-capability", "disabled-capability"].includes(host) ? { tools: [capabilities[0]] } : {}),
          });
          session = created.session;
          const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true });
          const errors: unknown[] = [];
          await session.bindExtensions({
            mode: "rpc",
            uiContext: (ctx as ExtensionContext).ui,
            onError: (error) => errors.push(error),
          });
          const expected = {
            unrestricted: 5,
            "filtered-all": 0,
            "allow-one": 1,
            "exclude-one": 4,
            "only-capability": 1,
            "disabled-capability": 0,
            "default-capability": 5,
          }[host];
          if (host === "default-capability") {
            assert.deepEqual(
              session.getActiveToolNames(),
              toolMode === "codemode"
                ? [capabilities[0]]
                : toolMode === "lazy"
                  ? [capabilities[0], "firecrawl_load", ...capabilities.slice(1)]
                  : capabilities,
            );
            assert.ok(!session.getActiveToolNames().includes("codemode"));
          }
          if (host === "only-capability" || host === "disabled-capability") {
            assert.deepEqual(session.getActiveToolNames(), host === "only-capability" ? [capabilities[0]] : []);
            assert.ok(!session.getActiveToolNames().includes("codemode"));
          }
          const callable = session.getCallableToolNames().filter((name) => capabilities.includes(name as never));
          assert.equal(callable.length, expected);
          const activeBefore = session.getActiveToolNames();
          const definitionsBefore = session.getAllTools();
          const promptBefore = session.systemPrompt;
          await session.prompt("/firecrawl status");
          await session.prompt("/firecrawl status");
          assert.deepEqual(errors, []);
          const statuses = notifications.filter((entry) => entry.message.startsWith("Firecrawl tools available:"));
          assert.equal(statuses.length, 2);
          for (const status of statuses) {
            assert.ok(
              status.message.includes(
                host === "disabled-capability" ? "partial (4/5 available)" : "enabled (5/5 available)",
              ),
            );
            assert.ok(status.message.includes(`Callable capability tools: ${expected}/5`), status.message);
          }
          assert.deepEqual(session.getActiveToolNames(), activeBefore);
          assert.deepEqual(session.getAllTools(), definitionsBefore);
          assert.equal(session.systemPrompt, promptBefore);
          assert.equal(await readFile(join(root, "pi-firecrawl.json"), "utf8"), original);
        } finally {
          await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session?.dispose();
        }
      });
    });
  }
}
