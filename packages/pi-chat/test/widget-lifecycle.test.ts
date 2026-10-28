import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { ChatTransport, ChatTransportListener } from "../src/chat-session.js";
import type { ChatMenuSource } from "../src/menu.js";
import { createPrivateRoom } from "../src/protocol.js";
import { updateChatSettings } from "../src/settings.js";

class ObservableTransport implements ChatTransport {
  listener: ChatTransportListener | undefined;
  stopped = 0;
  async start(listener: ChatTransportListener): Promise<void> {
    this.listener = listener;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  refresh(): void {
    this.listener?.onError(new Error("retry"));
  }
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
}

function mountedContext(mode: "tui" | "rpc" | "print" | "json" = "tui") {
  const context = createMockContext({
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    select: async (_title: string, options: string[]) => options.find((option) => option.startsWith("Join once")),
    custom: async () => undefined,
  });
  const mounted: Array<Component & { dispose?(): void }> = [];
  let active: (typeof mounted)[number] | undefined;
  let requests = 0;
  const tui = { terminal: { rows: 30 }, requestRender: () => requests++ };
  const theme = { fg: (_role: string, text: string) => text };
  const ctx = context.ctx as ExtensionCommandContext;
  ctx.ui.setWidget = (key, value) => {
    assert.equal(key, "chat");
    active?.dispose?.();
    active = undefined;
    if (typeof value === "function") {
      active = value(tui as never, theme as never);
      mounted.push(active);
    }
    context.widgets.set(key, value);
  };
  return {
    ...context,
    ctx,
    mounted,
    tui,
    get requests() {
      return requests;
    },
  };
}

async function fixture(
  run: (extension: typeof import("../src/pi-chat.js"), settingsPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-widget-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    const modulePath = "../src/pi-chat.js";
    const extension = (await import(
      `${modulePath}?widget=${crypto.randomUUID()}`
    )) as typeof import("../src/pi-chat.js");
    const settingsPath = join(root, "pi-chat.json");
    await updateChatSettings(
      { nickname: "Mika", identitySeed: Buffer.alloc(32, 7).toString("base64url"), widgetMode: "count" },
      { settingsPath },
    );
    await run(extension, settingsPath);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("live Chat refresh and display changes reuse the mounted frame and release its render callback", async () => {
  await fixture(async ({ createPiChatExtension }, settingsPath) => {
    const mock = createMockPi();
    const transport = new ObservableTransport();
    let source: ChatMenuSource | undefined;
    createPiChatExtension({
      settingsPath,
      createTransport: () => transport,
      loadChatMenu: async () => ({
        showChatMenu: async (_ctx, value) => {
          source = value;
        },
      }),
    })(mock.pi);
    const context = mountedContext();
    try {
      await emit(mock, "session_start", context.ctx);
      const command = mock.commands.get("chat");
      assert.ok(command);
      await command.handler(createPrivateRoom(Buffer.alloc(32, 8)).invite ?? "", context.ctx);
      await command.handler("", context.ctx);
      assert.ok(source);
      const component = context.mounted[0];
      assert.ok(component);
      assert.equal(context.mounted.length, 1);
      assert.equal(component.render(80)[0], "─".repeat(80));
      let requests = context.requests;
      transport.refresh();
      assert.ok(context.requests > requests);
      assert.match(component.render(80).join("\n"), /reconnecting/u);
      await source.updateWidgetMode("dock", new AbortController().signal);
      assert.equal(context.mounted.length, 1);
      assert.match(component.render(80).at(-1) ?? "", /Input → Pi\/LLM/u);
      context.tui.terminal.rows = 8;
      assert.equal(component.render(80).length, 3);
      await source.updateWidgetMode("off", new AbortController().signal);
      assert.equal(context.widgets.get("chat"), undefined);
      assert.deepEqual(component.render(80), []);
      requests = context.requests;
      transport.refresh();
      assert.equal(context.requests, requests);
      await source.updateWidgetMode("latest", new AbortController().signal);
      assert.equal(context.mounted.length, 2);
      const replacement = context.mounted[1];
      assert.ok(replacement);
      component.dispose?.();
      requests = context.requests;
      transport.refresh();
      assert.ok(context.requests > requests);
      replacement.dispose?.();
      replacement.dispose?.();
      requests = context.requests;
      transport.refresh();
      assert.equal(context.requests, requests);
      assert.deepEqual(replacement.render(80), []);
    } finally {
      await emit(mock, "session_shutdown", context.ctx);
    }
    assert.equal(transport.stopped, 1);
    assert.equal(context.widgets.get("chat"), undefined);
    assert.equal(context.statuses.get("chat"), undefined);
  });
});

test("replacement and stale disposal cannot publish or redraw through the old mounted Chat frame", async () => {
  await fixture(async ({ createPiChatExtension }, settingsPath) => {
    const mock = createMockPi();
    const transports: ObservableTransport[] = [];
    createPiChatExtension({
      settingsPath,
      createTransport: () => {
        const transport = new ObservableTransport();
        transports.push(transport);
        return transport;
      },
    })(mock.pi);
    const first = mountedContext();
    const second = mountedContext();
    try {
      await emit(mock, "session_start", first.ctx);
      const command = mock.commands.get("chat");
      assert.ok(command);
      const invite = createPrivateRoom(Buffer.alloc(32, 9)).invite ?? "";
      await command.handler(invite, first.ctx);
      const old = first.mounted[0];
      assert.ok(old);
      const oldRequests = first.requests;
      await emit(mock, "session_start", second.ctx);
      assert.equal(first.widgets.get("chat"), undefined);
      assert.equal(first.statuses.get("chat"), undefined);
      await command.handler(invite, second.ctx);
      const current = second.mounted[0];
      assert.ok(current);
      assert.equal(current.render(80)[0], "─".repeat(80));
      assert.deepEqual(old.render(80), []);
      old.dispose?.();
      await emit(mock, "session_shutdown", first.ctx);
      const requests = second.requests;
      transports[0]?.refresh();
      assert.equal(first.requests, oldRequests);
      assert.equal(second.requests, requests);
      transports[1]?.refresh();
      assert.ok(second.requests > requests);
      assert.match(current.render(80).join("\n"), /reconnecting/u);
    } finally {
      await emit(mock, "session_shutdown", second.ctx);
      await emit(mock, "session_shutdown", first.ctx);
    }
    assert.deepEqual(
      transports.map((transport) => transport.stopped),
      [1, 1],
    );
    assert.equal(second.widgets.get("chat"), undefined);
    assert.deepEqual(second.mounted[0]?.render(80), []);
  });
});

test("a delayed widget module cannot mount or start transport after session replacement", async () => {
  await fixture(async ({ createPiChatExtension }, settingsPath) => {
    const mock = createMockPi();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let creates = 0;
    createPiChatExtension({
      settingsPath,
      loadChatWidget: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
          started?.();
        });
        return import("../src/widget.js");
      },
      createTransport: () => {
        creates += 1;
        return new ObservableTransport();
      },
    })(mock.pi);
    const first = mountedContext();
    const second = mountedContext();
    try {
      await emit(mock, "session_start", first.ctx);
      const command = mock.commands.get("chat");
      assert.ok(command);
      const joining = command.handler(createPrivateRoom(Buffer.alloc(32, 10)).invite ?? "", first.ctx);
      await loading;
      await emit(mock, "session_start", second.ctx);
      release?.();
      await joining;
      assert.equal(creates, 0);
      assert.equal(first.mounted.length, 0);
      assert.equal(second.mounted.length, 0);
      assert.equal(first.widgets.get("chat"), undefined);
      assert.equal(second.widgets.get("chat"), undefined);
    } finally {
      release?.();
      await emit(mock, "session_shutdown", second.ctx);
      await emit(mock, "session_shutdown", first.ctx);
    }
  });
});

test("non-TUI startup and rejected joins never load or mount the Chat widget", async () => {
  await fixture(async ({ createPiChatExtension }, settingsPath) => {
    const mock = createMockPi();
    let loads = 0;
    createPiChatExtension({
      settingsPath,
      loadChatWidget: async () => {
        loads += 1;
        return import("../src/widget.js");
      },
      createTransport: () => {
        throw new Error("unexpected network start");
      },
    })(mock.pi);
    for (const mode of ["rpc", "print", "json"] as const) {
      const context = mountedContext(mode);
      try {
        await emit(mock, "session_start", context.ctx);
        const command = mock.commands.get("chat");
        assert.ok(command);
        await assert.rejects(async () => command.handler("#pi-dev", context.ctx), /TUI mode/u);
        assert.equal(loads, 0);
        assert.equal(context.mounted.length, 0);
        assert.equal(context.widgets.get("chat"), undefined);
      } finally {
        await emit(mock, "session_shutdown", context.ctx);
      }
    }
  });
});
