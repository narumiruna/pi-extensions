import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { Settings } from "../src/settings.js";

let root: string;
let previous: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-search-lifecycle-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../src/settings-ui.js");
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
});
async function setup(mode = "print") {
  await writeFile(
    join(root, "pi-web-search.json"),
    JSON.stringify({ accountId: "a".repeat(32), apiToken: "TOP_SECRET" }),
    { mode: 0o600 },
  );
  const { default: extension } = await import("../src/web-search.js");
  const mock = createMockPi();
  await extension(mock.pi);
  const context = createMockContext({ mode });
  const emit = async (name: string, ctx = context.ctx) => {
    for (const handler of mock.events.get(name) ?? []) await handler({ type: name }, ctx);
  };
  await emit("session_start");
  return { ...mock, ...context, emit, tool: mock.tools.at(-1) as unknown as ToolDefinition };
}

test.each(["print", "json", "rpc"])(
  "%s command safely reports help/status and rejects arguments without TUI",
  async (mode) => {
    const h = await setup(mode);
    const command = h.commands.get("web-search");
    assert.ok(command);
    const rejections: string[] = [];
    for (const args of ["", "settings trailing"]) {
      if (mode === "print")
        await assert.rejects(command.handler(args, h.ctx) as Promise<unknown>, (error: Error) => {
          rejections.push(error.message);
          return true;
        });
      else await command.handler(args, h.ctx);
    }
    const reports = JSON.stringify(mode === "print" ? rejections : mode === "rpc" ? h.notifications : h.sentMessages);
    assert.match(reports, /pi-web-search.json/);
    assert.match(reports, /does not accept arguments/);
    assert.doesNotMatch(reports, /TOP_SECRET/);
  },
);

test.each([600, 1024])("registered schema and runtime both accept %s astral code points", async (count) => {
  const h = await setup();
  const query = "😀".repeat(count);
  const args = validateToolArguments(h.tool, {
    type: "toolCall",
    id: "unicode",
    name: "web_search",
    arguments: { query },
  });
  let sent: unknown;
  vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
    sent = JSON.parse(String(options.body)).query;
    return new Response(JSON.stringify({ items: [], metadata: {} }));
  });
  await h.tool.execute("unicode", args, undefined, undefined, h.ctx as unknown as ExtensionToolContext);
  assert.equal(sent, query);
});

test.each(["print", "json", "rpc"])(
  "%s reports strip directional controls from the configured agent path",
  async (mode) => {
    process.env.PI_CODING_AGENT_DIR = join(root, "agent\u202e\u2066");
    const h = await setup(mode);
    const command = h.commands.get("web-search");
    assert.ok(command);
    let rejection = "";
    if (mode === "print")
      await assert.rejects(command.handler("", h.ctx) as Promise<unknown>, (error: Error) => {
        rejection = error.message;
        return true;
      });
    else await command.handler("", h.ctx);
    const output = mode === "print" ? rejection : JSON.stringify(mode === "rpc" ? h.notifications : h.sentMessages);
    assert.doesNotMatch(output, /\p{Bidi_Control}/u);
    assert.match(output, /pi-web-search.json/);
  },
);

test.each(["runtime-failure", "busy"])("rollback adopts external fields before another edit: %s", async (scenario) => {
  let restored: Settings | undefined;
  vi.doMock("../src/settings-ui.js", () => ({
    showSettings: async (
      _ctx: unknown,
      current: () => Settings,
      save: (patch: Partial<Settings>, signal: AbortSignal) => Promise<void>,
      signal: AbortSignal,
    ) => {
      await writeFile(
        join(root, "pi-web-search.json"),
        JSON.stringify({
          accountId: "a".repeat(32),
          apiToken: "TOP_SECRET",
          limit: 8,
          gatewayId: "external",
          future: { keep: true },
        }),
        { mode: 0o600 },
      );
      await assert.rejects(save({ exposure: "direct" }, signal));
      restored = { ...current() };
      await save({ limit: current().limit + 1 }, signal);
    },
  }));
  const h = await setup("tui");
  const ctx = h.ctx as unknown as ExtensionCommandContext;
  ctx.ui.select = async () => "Settings";
  if (scenario === "busy") ctx.isIdle = () => false;
  else {
    const register = h.rawPi.registerTool;
    let fail = true;
    h.rawPi.registerTool = (tool) => {
      if (fail && (tool as ToolDefinition).exposure === "direct") {
        fail = false;
        throw new Error("runtime failure");
      }
      register(tool);
    };
  }
  await h.commands.get("web-search")?.handler("", ctx);
  const { readFile } = await import("node:fs/promises");
  const doc = JSON.parse(await readFile(join(root, "pi-web-search.json"), "utf8"));
  assert.equal(restored?.exposure, "codemode");
  assert.equal(restored?.limit, 8);
  assert.equal(restored?.gatewayId, "external");
  assert.equal(doc.limit, 9);
  assert.deepEqual(doc.future, { keep: true });
  let body: unknown;
  vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
    body = JSON.parse(String(options.body));
    return new Response(JSON.stringify({ items: [], metadata: {} }));
  });
  await h.tool.execute("call", { query: "news" }, undefined, undefined, ctx as unknown as ExtensionToolContext);
  assert.equal((body as { limit: number }).limit, 9);
});

test.each(["busy-restoration", "runtime-restoration", "previous-definition-restoration"])(
  "recovery fails closed without mid-run exposure changes: %s",
  async (scenario) => {
    let failed = false;
    let shown: Settings | undefined;
    vi.doMock("../src/settings-ui.js", () => ({
      showSettings: async (
        _ctx: unknown,
        current: () => Settings,
        save: (patch: Partial<Settings>, signal: AbortSignal) => Promise<void>,
        signal: AbortSignal,
      ) => {
        await writeFile(
          join(root, "pi-web-search.json"),
          JSON.stringify({
            accountId: "a".repeat(32),
            apiToken: "TOP_SECRET",
            exposure: scenario === "previous-definition-restoration" ? "codemode" : "direct",
            limit: 8,
          }),
          { mode: 0o600 },
        );
        try {
          await save(scenario === "previous-definition-restoration" ? { exposure: "direct" } : { limit: 7 }, signal);
        } catch {
          failed = true;
        }
        // A later preference-only save must not clear a failed runtime recovery.
        await assert.rejects(save({ limit: 6 }, signal), /recovery failed/);
        shown = { ...current() };
      },
    }));
    const h = await setup("tui");
    const ctx = h.ctx as unknown as ExtensionCommandContext;
    ctx.ui.select = async () => "Settings";
    let idleChecks = 0;
    if (scenario !== "previous-definition-restoration")
      ctx.isIdle = () => {
        idleChecks++;
        return scenario === "runtime-restoration" && idleChecks > 1;
      };
    const register = h.rawPi.registerTool;
    const attempts: string[] = [];
    h.rawPi.registerTool = (tool) => {
      attempts.push((tool as ToolDefinition).exposure ?? "direct");
      if (
        scenario === "previous-definition-restoration" ||
        (scenario === "runtime-restoration" && (tool as ToolDefinition).exposure === "direct")
      )
        throw new Error("TOP_SECRET runtime failure");
      register(tool);
    };
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await h.commands.get("web-search")?.handler("", ctx);
    assert.ok(failed);
    assert.equal(shown?.exposure, "codemode");
    const { readFile } = await import("node:fs/promises");
    const doc = JSON.parse(await readFile(join(root, "pi-web-search.json"), "utf8"));
    assert.equal(doc.exposure, scenario === "previous-definition-restoration" ? "codemode" : "direct");
    assert.equal(doc.limit, scenario === "previous-definition-restoration" ? 8 : 5);
    if (scenario === "busy-restoration") assert.deepEqual(attempts, []);
    await assert.rejects(
      h.tool.execute("call", { query: "news" }, undefined, undefined, ctx as unknown as ExtensionToolContext),
      /recovery failed/,
    );
    assert.equal(request.mock.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(h.notifications), /TOP_SECRET/);
  },
);

test("replacement during rollback prevents stale restored state from being applied", async () => {
  vi.doMock("../src/settings-ui.js", () => ({
    showSettings: async (
      _ctx: unknown,
      _current: () => Settings,
      save: (patch: Partial<Settings>, signal: AbortSignal) => Promise<void>,
      signal: AbortSignal,
    ) => {
      await writeFile(
        join(root, "pi-web-search.json"),
        JSON.stringify({ accountId: "a".repeat(32), apiToken: "TOP_SECRET", limit: 8 }),
        { mode: 0o600 },
      );
      await save({ exposure: "direct" }, signal);
    },
  }));
  const h = await setup("tui");
  const ctx = h.ctx as unknown as ExtensionCommandContext;
  ctx.ui.select = async () => "Settings";
  const replacement = createMockContext({ mode: "print" });
  const register = h.rawPi.registerTool;
  h.rawPi.registerTool = (tool) => {
    if ((tool as ToolDefinition).exposure === "direct") throw new Error("runtime failure");
    register(tool);
  };
  const { SettingsStore } = await import("../src/settings.js");
  const save = SettingsStore.prototype.save;
  let calls = 0;
  vi.spyOn(SettingsStore.prototype, "save").mockImplementation(async function (
    this: InstanceType<typeof SettingsStore>,
    patch,
    signal,
  ) {
    const number = ++calls;
    const restored = await save.call(this, patch, signal);
    if (number === 2) {
      await writeFile(
        join(root, "pi-web-search.json"),
        JSON.stringify({ accountId: "a".repeat(32), apiToken: "TOP_SECRET", limit: 10 }),
        { mode: 0o600 },
      );
      await h.emit("session_start", replacement.ctx);
    }
    return restored;
  });
  await h.commands.get("web-search")?.handler("", ctx);
  let limit: unknown;
  vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
    limit = JSON.parse(String(options.body)).limit;
    return new Response(JSON.stringify({ items: [], metadata: {} }));
  });
  await h.tool.execute(
    "new",
    { query: "news" },
    undefined,
    undefined,
    replacement.ctx as unknown as ExtensionToolContext,
  );
  assert.equal(limit, 10);
  await assert.rejects(
    h.tool.execute("old", { query: "news" }, undefined, undefined, ctx as unknown as ExtensionToolContext),
    /not active/,
  );
  assert.equal(h.notifications.length, 0);
});

test.each(["session_shutdown", "session_start"])(
  "%s cancels pending network work even when headless UI is shared",
  async (event) => {
    const h = await setup();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      async (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = options.signal as AbortSignal;
          requestSignal.addEventListener("abort", () => reject(new Error("transport")), { once: true });
          ready();
        }),
    );
    const pending = h.tool.execute(
      "call",
      { query: "news" },
      undefined,
      undefined,
      h.ctx as unknown as ExtensionToolContext,
    );
    const rejection = assert.rejects(pending, /cancelled/);
    await started;
    const replacement = createMockContext({ mode: "print" });
    Object.assign(replacement.ctx, { ui: (h.ctx as unknown as ExtensionToolContext).ui });
    await h.emit(event, event === "session_shutdown" ? h.ctx : replacement.ctx);
    await rejection;
    assert.ok(requestSignal?.aborted);
    if (event === "session_shutdown") await h.emit(event);
    else
      await assert.rejects(
        h.tool.execute("old", { query: "news" }, undefined, undefined, h.ctx as unknown as ExtensionToolContext),
        /not active/,
      );
  },
);

test("a stale shutdown cannot cancel the replacement session sharing the same headless UI", async () => {
  const h = await setup();
  const replacement = createMockContext({ mode: "print" });
  Object.assign(replacement.ctx, { ui: (h.ctx as unknown as ExtensionToolContext).ui });
  await h.emit("session_start", replacement.ctx);
  await h.emit("session_shutdown", h.ctx);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items: [], metadata: {} })));
  const result = await h.tool.execute(
    "new",
    { query: "news" },
    undefined,
    undefined,
    replacement.ctx as unknown as ExtensionToolContext,
  );
  assert.match(JSON.stringify(result), /No results/);
  await h.emit("session_shutdown", replacement.ctx);
  await assert.rejects(
    h.tool.execute(
      "closed",
      { query: "news" },
      undefined,
      undefined,
      replacement.ctx as unknown as ExtensionToolContext,
    ),
    /not active/,
  );
});

test("invalid session-start settings fail closed, never overwrite the file or leak secrets", async () => {
  const h = await setup();
  const invalid = '{"apiToken":"TOP_SECRET",';
  await writeFile(join(root, "pi-web-search.json"), invalid);
  await h.emit("session_start");
  await assert.rejects(
    h.tool.execute("call", { query: "news" }, undefined, undefined, h.ctx as unknown as ExtensionToolContext),
    /Invalid pi-web-search.json/,
  );
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(join(root, "pi-web-search.json"), "utf8"), invalid);
  assert.doesNotMatch(JSON.stringify(h.sentMessages), /TOP_SECRET/);
});

test("project settings and environment aliases do not override user settings", async () => {
  const h = await setup();
  await mkdir(join(root, ".pi"));
  await writeFile(
    join(root, ".pi", "pi-web-search.json"),
    JSON.stringify({ apiToken: "PROJECT_SECRET", exposure: "direct" }),
  );
  Object.assign(h.ctx, { cwd: root, isProjectTrusted: () => true });
  await h.emit("session_start");
  assert.equal(h.tools.at(-1)?.exposure, "codemode");
  let auth: unknown;
  vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
    auth = options.headers;
    return new Response(JSON.stringify({ items: [], metadata: {} }));
  });
  await h.tool.execute("call", { query: "news" }, undefined, undefined, h.ctx as unknown as ExtensionToolContext);
  assert.deepEqual(auth, { Authorization: "Bearer TOP_SECRET", "Content-Type": "application/json" });
});

test.each(["success", "runtime-failure", "busy", "recovery-failure"])(
  "command persists and applies preferences safely: %s",
  async (scenario) => {
    let shown: Settings | undefined;
    let failed = false;
    vi.doMock("../src/settings-ui.js", () => ({
      showSettings: async (
        _ctx: unknown,
        current: () => Settings,
        save: (patch: Partial<Settings>, signal: AbortSignal) => Promise<void>,
        signal: AbortSignal,
      ) => {
        try {
          await save({ exposure: "direct", limit: 7 }, signal);
        } catch {
          failed = true;
        }
        shown = { ...current() };
      },
    }));
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const h = await setup("tui");
    assert.equal(request.mock.calls.length, 0); // factory/startup never send requests
    const ctx = h.ctx as unknown as ExtensionCommandContext;
    ctx.ui.select = async () => "Settings";
    if (scenario === "busy") ctx.isIdle = () => false;
    if (scenario === "runtime-failure" || scenario === "recovery-failure") {
      const register = h.rawPi.registerTool;
      let fail = true;
      h.rawPi.registerTool = (tool) => {
        if (fail && (tool as ToolDefinition).exposure === "direct") {
          fail = false;
          throw new Error("runtime failure");
        }
        register(tool);
      };
    }
    if (scenario === "recovery-failure") {
      const { SettingsStore } = await import("../src/settings.js");
      const save = SettingsStore.prototype.save;
      let calls = 0;
      vi.spyOn(SettingsStore.prototype, "save").mockImplementation(function (
        this: InstanceType<typeof SettingsStore>,
        patch,
        signal,
      ) {
        calls++;
        return calls === 2 ? Promise.reject(new Error("disk rollback failed")) : save.call(this, patch, signal);
      });
    }
    const command = h.commands.get("web-search");
    assert.ok(command);
    await command.handler("", ctx);
    const { readFile } = await import("node:fs/promises");
    const document = JSON.parse(await readFile(join(root, "pi-web-search.json"), "utf8"));
    assert.equal(shown?.exposure, scenario === "success" ? "direct" : "codemode");
    assert.equal(failed, scenario !== "success");
    assert.equal(
      document.exposure ?? "codemode",
      scenario === "success" || scenario === "recovery-failure" ? "direct" : "codemode",
    );
    assert.equal(document.limit ?? 5, scenario === "success" || scenario === "recovery-failure" ? 7 : 5);
    if (scenario === "recovery-failure") {
      await assert.rejects(
        h.tool.execute("call", { query: "news" }, undefined, undefined, ctx as unknown as ExtensionToolContext),
        /recovery failed/,
      );
      assert.match(JSON.stringify(h.notifications), /repair pi-web-search.json/);
    }
    assert.doesNotMatch(JSON.stringify(h.notifications), /TOP_SECRET/);
  },
);
