import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  type Extension,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { type BuildMetadata, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({ packageId: "pi-inspect" });

async function fixture(run: (h: Awaited<ReturnType<typeof loadFixture>>) => Promise<void>) {
  const root = await mkdtemp(join(packageRoot, ".pi-inspect-build-test-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousPath = process.env.PATH;
  let h: Awaited<ReturnType<typeof loadFixture>> | undefined;
  try {
    const builder = await loadBuilder();
    await builder.buildRuntime({ outputDirectory: join(root, "dist") });
    await cp(join(packageRoot, "browser-dist"), join(root, "browser-dist"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    await mkdir(process.env.PI_CODING_AGENT_DIR);
    h = await loadFixture(root);
    // A generated entry must not open the developer's desktop browser during tests.
    process.env.PATH = join(root, "no-executables");
    await run(h);
  } finally {
    if (h) await h.emit("session_shutdown");
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

async function loadFixture(root: string) {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [join(root, "dist/index.ts")],
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0] as Extension;
  // Bind only the read-only host actions used by the viewer; no model is needed.
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.getActiveTools = () => [];
  const messages: string[] = [];
  let accept = true;
  let consentCount = 0;
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    sessionManager: SessionManager.inMemory(root),
    getSystemPrompt: () => "stable prompt",
    getSystemPromptOptions: () => ({ cwd: root, skills: [] }),
    ui: {
      confirm: async () => {
        consentCount++;
        return accept;
      },
      notify: (message: string) => messages.push(message),
    },
  } as unknown as ExtensionCommandContext;
  async function emit(name: string, event: unknown = {}, context: ExtensionContext = ctx) {
    for (const handler of extension.handlers.get(name) ?? [])
      assert.equal(await handler(event as never, context), undefined);
  }
  const command = extension.commands.get("inspect");
  assert.ok(command);
  return {
    root,
    ctx,
    extension,
    messages,
    emit,
    run: (args = "", context = ctx) => command.handler(args, context),
    accept: (value: boolean) => {
      accept = value;
    },
    consentCount: () => consentCount,
    url: () => {
      const url = messages
        .join("\n")
        .match(/http:\/\/127\.0\.0\.1:[^\s]+/gu)
        ?.at(-1);
      assert.ok(url, "viewer must expose a private URL after startup");
      return new URL(url);
    },
  };
}

async function snapshot(url: URL) {
  const token = url.hash.slice(1);
  const shell = await (await fetch(url.origin)).text();
  const generation = shell.match(/name="inspector-generation" content="([^"]+)"/u)?.[1];
  assert.ok(token);
  assert.ok(generation);
  return fetch(`${url.origin}/api/snapshot?generation=${generation}`, { headers: { "X-Inspector-Token": token } });
}

test("Inspector runtime rejects browser source in its Node graph", async () => {
  const builder = await loadBuilder();
  const metadata: BuildMetadata = {
    outputs: { "dist/index.ts": { entryPoint: "src/index.ts", inputs: { "src/web/app.tsx": {} }, imports: [] } },
  };
  expect(() => builder.validateEagerGraph(metadata)).toThrow("Browser source");
});

test("generated Inspector serves real assets, captures without mutation, and revokes on replacement", async () => {
  await fixture(async (h) => {
    expect([...h.extension.commands.keys()]).toEqual(["inspect", "session-inspector"]);
    await h.emit("session_start");
    const before = { messages: [{ role: "user", content: "before consent" }] };
    const unchanged = structuredClone(before);
    await h.emit("context_with_system", before);
    expect(before).toEqual(unchanged);
    h.accept(false);
    await h.run();
    expect(h.messages).toEqual([]);
    h.accept(true);
    await h.run();
    expect(h.consentCount()).toBe(2);
    const url = h.url();
    for (const route of ["/", "/app.js", "/app.css"]) {
      const response = await fetch(`${url.origin}${route}`);
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(0);
    }
    const first = { system: "stable", tools: [], messages: [{ role: "user", content: "captured" }] };
    const baseline = structuredClone(first);
    await h.emit("context_with_system", first);
    await h.emit("before_provider_request", { payload: first });
    expect(first).toEqual(baseline);
    const second = { ...structuredClone(first), messages: [...first.messages, { role: "assistant", content: "next" }] };
    const expected = structuredClone(second);
    await h.emit("context_with_system", second);
    await h.emit("before_provider_request", { payload: second });
    expect(second).toEqual(expected);
    expect(second.messages.slice(0, first.messages.length)).toEqual(baseline.messages);
    const response = await snapshot(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ context: { source: "observed-pi-context" } });
    expect((await fetch(`${url.origin}/api/snapshot`)).status).toBe(401);
    await h.emit("session_start");
    await expect(fetch(url.origin)).rejects.toThrow();
    await h.run();
    const next = h.url();
    expect((await snapshot(next)).status).toBe(200);
    await h.run("stop");
    await h.run("stop");
    await expect(fetch(next.origin)).rejects.toThrow();
    await h.emit("session_shutdown");
    await h.emit("session_shutdown");
  });
});

test("generated Inspector retries missing assets and preserves command mode restrictions", async () => {
  await fixture(async (h) => {
    const css = join(h.root, "browser-dist/app.css");
    const saved = await readFile(css);
    await rm(css);
    await h.run();
    expect(h.messages.at(-1)).toContain("Could not open");
    await writeFile(css, saved);
    await h.run();
    expect((await snapshot(h.url())).status).toBe(200);
    await h.run("stop");
    const count = h.consentCount();
    for (const mode of ["rpc", "json", "print"] as const) {
      const ctx = { ...h.ctx, mode, hasUI: mode === "rpc" };
      if (mode === "rpc") await h.run("", ctx);
      else await expect(h.run("", ctx)).rejects.toThrow("requires TUI");
      await h.run("stop", ctx);
    }
    expect(h.consentCount()).toBe(count);
    await expect(h.run("invalid", { ...h.ctx, mode: "print", hasUI: false })).rejects.toThrow("Usage");
  });
});
