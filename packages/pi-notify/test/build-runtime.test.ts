import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Extension, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { withGeneratedRuntime } from "../../../test/generated-runtime-fixture.js";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-notify",
  forbiddenEagerInputs: ["src/menu.ts", "src/destination-ui.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  allowedEagerExternals: ["@narumitw/pi-tui-kit/terminal-text"],
});

const token = `123:${"s".repeat(30)}`;
const settings = {
  enabled: true,
  mode: "immediate",
  targetIds: ["one"],
  destinations: { one: { provider: "telegram", label: "Personal", botToken: token, chatId: "123" } },
};

test("generated graph keeps provider validation eager and both menu modules lazy", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-notify-build-test-"));
  try {
    const output = join(root, "dist");
    const metadata = await builder.buildRuntime({ outputDirectory: output });
    const { eagerInputs } = builder.validateEagerGraph(metadata);
    for (const source of [
      "settings",
      "coordinator",
      "providers",
      ...["telegram", "gotify", "slack", "ntfy", "pushover", "discord", "bark", "webhook", "line", "teams"].map(
        (provider) => `providers/${provider}`,
      ),
    ]) {
      assert.ok(
        [...eagerInputs].some((input) => input.endsWith(`/src/${source}.ts`)),
        source,
      );
    }
    for (const source of ["menu", "destination-ui"]) {
      assert.ok(
        Object.keys(metadata.inputs ?? {}).some((input) => input.endsWith(`src/${source}.ts`)),
        source,
      );
      assert.equal(
        [...eagerInputs].some((input) => input.endsWith(`/src/${source}.ts`)),
        false,
        source,
      );
    }
    // The shared contract also rejects the root, other subpaths, and descendants of this exact exception.
    assert.ok(
      Object.values(metadata.outputs ?? {}).some((chunk) =>
        chunk.imports?.some((imported) => imported.path === "@narumitw/pi-tui-kit/terminal-text" && imported.external),
      ),
    );
    const entry = join(output, "index.ts");
    const source = await readFile(entry, "utf8");
    const missingTarget = source.replace(/import\("\.\/chunks\/menu-[^"]+\.ts"\)/u, 'import("./chunks/missing.js")');
    assert.notEqual(missingTarget, source, "entry must retain the dynamic menu import");
    await writeFile(entry, missingTarget);
    await assert.rejects(
      builder.validateGeneratedFiles(output),
      /Generated relative import has no exact runtime target/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface RuntimeHarness {
  extension: Extension;
  ctx: ExtensionCommandContext;
  tui: ReturnType<typeof createTuiHarness>;
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  notifyUI: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  settingsPath: string;
  emit(name: string, event?: unknown): Promise<void>;
  command(args?: string): Promise<void>;
}

async function withNotifyRuntime(
  mode: ExtensionContext["mode"],
  run: (harness: RuntimeHarness) => Promise<void>,
): Promise<void> {
  const builder = await loadBuilder();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true, result: {} }));
  vi.stubGlobal("fetch", fetcher);
  try {
    await withGeneratedRuntime(packageRoot, builder, async (extension) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR;
      assert.ok(agentDir);
      const tui = createTuiHarness();
      const notifyUI = vi.fn();
      const unsubscribe = vi.fn();
      const subscribe = vi.fn(() => unsubscribe);
      const ctx = {
        mode,
        hasUI: mode === "tui" || mode === "rpc",
        cwd: agentDir,
        isProjectTrusted: () => false,
        sessionManager: { getSessionId: () => "generated-notify", getSessionName: () => "Generated session" },
        ui: { custom: tui.custom, notify: notifyUI, onTerminalInput: subscribe },
      } as unknown as ExtensionCommandContext;
      const emit = async (name: string, event: unknown = {}) => {
        for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
      };
      const command = extension.commands.get("notify");
      assert.ok(command);
      try {
        await run({
          extension,
          ctx,
          tui,
          fetcher,
          notifyUI,
          subscribe,
          unsubscribe,
          settingsPath: join(agentDir, "pi-notify.json"),
          emit,
          command: async (args = "") => {
            await command.handler(args, ctx);
          },
        });
      } finally {
        try {
          await emit("session_shutdown");
          await emit("session_shutdown");
        } finally {
          tui.dispose();
        }
      }
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

async function enable(h: RuntimeHarness, mode = "immediate") {
  await writeFile(h.settingsPath, JSON.stringify({ ...settings, mode }));
}

test("generated Jiti factory remains passive with the same commands and session hooks", async () => {
  await withNotifyRuntime("tui", async (h) => {
    assert.deepEqual([...h.extension.commands.keys()], ["notify"]);
    assert.deepEqual(
      [...h.extension.handlers.keys()],
      ["session_start", "before_agent_start", "agent_start", "message_end", "agent_settled", "session_shutdown"],
    );
    assert.equal(h.extension.tools.size, 0);
    assert.equal(h.fetcher.mock.calls.length, 0);
    assert.equal(h.subscribe.mock.calls.length, 0);
    assert.equal(h.tui.openCount, 0);
    assert.deepEqual(await readdir(h.ctx.cwd), []);
    await h.emit("session_start");
    await h.emit("session_start");
    assert.equal(h.unsubscribe.mock.calls.length, 1);
    await h.emit("session_shutdown");
    await h.emit("session_shutdown");
    assert.equal(h.unsubscribe.mock.calls.length, 2);
    assert.equal(h.fetcher.mock.calls.length, 0);
  });
});

test.each(["tui.select.cancel", "ctrl+c"] as const)("generated lazy menu opens and cancels with %s", async (key) => {
  await withNotifyRuntime("tui", async (h) => {
    await enable(h);
    const original = await readFile(h.settingsPath, "utf8");
    await h.emit("session_start");
    const running = h.command();
    await h.tui.waitForOpen();
    assert.match(h.tui.render().join("\n"), /Destinations/u);
    await h.command();
    assert.deepEqual(h.notifyUI.mock.calls.at(-1), ["Notify menu is already open.", "info"]);
    const openCount = h.tui.openCount;
    h.tui.press("tui.select.confirm");
    await vi.waitFor(
      () => {
        assert.ok(h.tui.openCount > openCount);
        assert.equal(h.tui.isOpen, true);
      },
      { interval: 1 },
    );
    assert.match(h.tui.render().join("\n"), /Personal/u);
    h.tui.press("ctrl+c");
    await running;
    const reopened = h.command();
    await h.tui.waitForOpen();
    h.tui.press(key);
    await reopened;
    assert.equal(h.tui.isOpen, false);
    assert.equal(await readFile(h.settingsPath, "utf8"), original);
    assert.equal(h.fetcher.mock.calls.length, 0);
  });
});

test.each(["session_start", "session_shutdown"])("generated %s releases an open lazy menu", async (boundary) => {
  await withNotifyRuntime("tui", async (h) => {
    await h.emit("session_start");
    const running = h.command();
    await h.tui.waitForOpen();
    await h.emit(boundary);
    await running;
    assert.equal(h.tui.isOpen, false);
    assert.equal(h.unsubscribe.mock.calls.length, 1);
    if (boundary === "session_start") {
      const reopened = h.command();
      await h.tui.waitForOpen();
      h.tui.press("ctrl+c");
      await reopened;
    } else await assert.rejects(h.command(), /Notify session is unavailable/u);
    assert.equal(h.notifyUI.mock.calls.length, 0);
  });
});

test.each(["rpc", "print", "json"] as const)(
  "generated %s preserves settlement delivery and rejects interactive setup",
  async (mode) => {
    await withNotifyRuntime(mode, async (h) => {
      await enable(h, "after-inactivity");
      await h.emit("session_start");
      await h.emit("agent_settled", { aborted: false });
      await h.emit("before_agent_start");
      await h.emit("agent_start");
      await h.emit("agent_end");
      assert.equal(h.fetcher.mock.calls.length, 0);
      await h.emit("message_end", { message: { role: "assistant", stopReason: "error", content: "private answer" } });
      await h.emit("agent_settled", { aborted: false });
      await vi.waitFor(() => assert.equal(h.fetcher.mock.calls.length, 1), { interval: 1 });
      const [url, init] = h.fetcher.mock.calls[0] ?? [];
      assert.equal(url, `https://api.telegram.org/bot${token}/sendMessage`);
      const body = JSON.parse(String(init?.body));
      assert.match(body.text, /Pi stopped with an error/u);
      assert.match(body.text, /Generated session/u);
      assert.doesNotMatch(body.text, /private answer/u);
      await h.emit("agent_settled", { aborted: false });
      await h.emit("before_agent_start");
      await h.emit("agent_settled", { aborted: true });
      if (mode === "rpc") {
        await h.command();
        assert.match(String(h.notifyUI.mock.calls.at(-1)?.[0]), /Notify setup requires TUI/u);
      } else await assert.rejects(h.command(), /requires TUI/u);
      await assert.rejects(h.command("settings trailing"), /Usage: \/notify/u);
      assert.equal(h.tui.openCount, 0);
      assert.equal(h.subscribe.mock.calls.length, 0);
      assert.equal(h.fetcher.mock.calls.length, 1);
    });
  },
);

test("generated replacement and shutdown abort in-flight delivery without stale warnings", async () => {
  await withNotifyRuntime("rpc", async (h) => {
    await enable(h);
    h.fetcher.mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("private provider failure")), { once: true });
        }),
    );
    await h.emit("session_start");
    for (const [index, boundary] of ["session_start", "session_shutdown"].entries()) {
      await h.emit("before_agent_start");
      await h.emit("agent_settled", { aborted: false });
      await vi.waitFor(() => assert.equal(h.fetcher.mock.calls.length, index + 1), { interval: 1 });
      const signal = h.fetcher.mock.calls.at(-1)?.[1]?.signal;
      assert.equal(signal?.aborted, false);
      await h.emit(boundary);
      assert.equal(signal?.aborted, true);
    }
    assert.equal(h.notifyUI.mock.calls.length, 0);
  });
});

test("generated failed initialization permits repeated cleanup and a fresh session", async () => {
  await withNotifyRuntime("tui", async (h) => {
    h.subscribe.mockImplementationOnce(() => {
      throw new Error("input subscription failed");
    });
    await assert.rejects(h.emit("session_start"), /input subscription failed/u);
    await h.emit("session_shutdown");
    await h.emit("session_shutdown");
    await h.emit("session_start");
    const running = h.command();
    await h.tui.waitForOpen();
    h.tui.press("ctrl+c");
    await running;
    await h.emit("session_shutdown");
    assert.equal(h.unsubscribe.mock.calls.length, 1);
    assert.equal(h.fetcher.mock.calls.length, 0);
  });
});

test.each(["invalid-token", "unsupported-provider"])("generated settings fail closed for %s", async (failure) => {
  await withNotifyRuntime("rpc", async (h) => {
    await writeFile(
      h.settingsPath,
      JSON.stringify({
        ...settings,
        destinations: {
          one: {
            ...settings.destinations.one,
            ...(failure === "invalid-token" ? { botToken: "private-invalid-token" } : { provider: "unknown" }),
          },
        },
      }),
    );
    await h.emit("session_start");
    assert.match(String(h.notifyUI.mock.calls[0]?.[0]), /Invalid destination or unsupported provider/u);
    assert.doesNotMatch(JSON.stringify(h.notifyUI.mock.calls), /private-invalid-token/u);
    await h.emit("before_agent_start");
    await h.emit("agent_settled", { aborted: false });
    await h.emit("session_shutdown");
    assert.equal(h.fetcher.mock.calls.length, 0);
  });
});
