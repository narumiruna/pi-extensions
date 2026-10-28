import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { Type } from "typebox";
import { startServer, type ViewerServer } from "../src/server.js";

test("real Pi codemode, live browser, reload credential rotation and shutdown", async ({ page }) => {
  const temp = await mkdtemp(join(tmpdir(), "inspector-live-"));
  process.env.PI_CODING_AGENT_DIR = temp;
  const { registerInspector } = await import("../src/extension.js");
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const runtime = await ModelRuntime.create({
    authPath: join(temp, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("codemode", { code: "text(await tools.fixture_child({value:42}));" }, { id: "script" }),
    ]),
    fauxAssistantMessage("finished"),
  ]);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const servers: ViewerServer[] = [];
  let readyWait: () => void = () => {};
  const waitStarted = new Promise<void>((resolve) => {
    readyWait = resolve;
  });
  const loader = new DefaultResourceLoader({
    cwd: temp,
    agentDir: temp,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    extensionFactories: [
      createCodemodeExtension(),
      (pi) => {
        registerInspector(pi, {
          start: async (options) => {
            const server = await startServer(options);
            servers.push(server);
            return server;
          },
          launch: async (_pi, url, signal) => {
            signal.throwIfAborted();
            await page.goto(url);
            signal.throwIfAborted();
            return true;
          },
        });
        pi.registerTool({
          name: "fixture_wait",
          label: "Fixture wait",
          description: "cancellable fixture",
          exposure: "codemode",
          parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            if (!signal) throw new Error("Missing owned signal");
            signal.throwIfAborted();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("fixture cancelled")), { once: true });
              readyWait();
            });
            return { content: [], details: undefined };
          },
        });
        pi.registerTool({
          name: "fixture_child",
          label: "Fixture child",
          description: "fixture child",
          exposure: "codemode",
          parameters: Type.Object({ value: Type.Number() }),
          execute: async (_id, args) => ({
            content: [{ type: "text", text: `answer ${args.value}` }],
            details: undefined,
          }),
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: temp,
    agentDir: temp,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(temp),
    modelRuntime: runtime,
    model: faux.getModel(),
    tools: ["codemode", "fixture_child", "fixture_wait"],
  });
  const host = new AgentSessionRuntime(
    session,
    {
      cwd: temp,
      agentDir: temp,
      modelRuntime: runtime,
      settingsManager: settings,
      resourceLoader: loader,
      diagnostics: [],
    },
    async () => {
      throw new Error("Replacement is covered by the RPC smoke");
    },
  );
  const errors: string[] = [];
  const bindings = {
    mode: "tui" as const,
    uiContext: { confirm: async () => true, notify: () => {} } as unknown as ExtensionUIContext,
    onError: (error: unknown) => {
      errors.push(JSON.stringify(error));
    },
  };
  try {
    await session.bindExtensions(bindings);
    await session.prompt("/inspect");
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await session.prompt("run real codemode");
    await page.getByRole("tab", { name: "Session", exact: true }).click();
    await page.getByRole("tab", { name: /^Captured executions ·/ }).click();
    await expect(page.getByRole("button", { name: "codemode · ok", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Expand calls", exact: true }).click();
    const child = page.getByRole("button", { name: "fixture_child · ok", exact: true });
    await expect(child).toBeVisible();
    await child.click();
    await page.locator(".inspector-panel .json-object").evaluateAll((elements) => {
      for (const element of elements) (element as HTMLDetailsElement).open = true;
    });
    await expect(page.locator(".inspector-panel").getByText('"answer 42"', { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Related execution · codemode · call-1", exact: true }),
    ).toBeVisible();
    faux.appendResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", { code: "await tools.fixture_wait({});" }, { id: "cancel-script" }),
      ]),
    ]);
    const pendingRun = session.prompt("run cancellable codemode");
    await waitStarted;
    await session.abort();
    await pendingRun;
    await expect(page.getByRole("button", { name: "codemode · error", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Expand calls", exact: true }).click();
    await expect(page.getByRole("button", { name: "fixture_wait · error", exact: true })).toBeVisible();
    const old = servers[0];
    expect(old).toBeDefined();
    await session.reload();
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    if (old) await expect(fetch(old.origin)).rejects.toThrow();
    await session.bindExtensions(bindings);
    await session.prompt("/inspect");
    expect(servers[1]?.token).not.toBe(old?.token);
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await session.prompt("/inspect stop");
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    await session.prompt("/inspect");
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await host.dispose();
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    const finalServer = servers.at(-1);
    if (finalServer) await expect(fetch(finalServer.origin)).rejects.toThrow();
    expect(errors).toEqual([]);
    expect(faux.state.callCount).toBe(3);
  } finally {
    await host.dispose();
    await Promise.all(servers.map((server) => server.close()));
    await rm(temp, { recursive: true, force: true });
  }
});
