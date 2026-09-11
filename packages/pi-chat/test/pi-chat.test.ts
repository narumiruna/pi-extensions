import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import type { ChatTransport } from "../src/chat-session.js";
import type { PublicRoomDirectory } from "../src/directory-network.js";
import { createPiChatExtension as createProductionPiChatExtension, type PiChatDependencies } from "../src/pi-chat.js";
import { createPrivateRoom, createPublicRoom } from "../src/protocol.js";
import type { PublicRoomBrowseResult } from "../src/public-room-directory.js";
import { updateChatSettings } from "../src/settings.js";

class IdleDirectory implements PublicRoomDirectory {
  started = 0;
  browsed = 0;
  stopped = 0;
  result: PublicRoomBrowseResult = { rooms: [], partial: false };
  async start(): Promise<void> {
    this.started += 1;
  }
  async browse(signal: AbortSignal): Promise<PublicRoomBrowseResult> {
    this.browsed += 1;
    signal.throwIfAborted();
    return this.result;
  }
  async stop(): Promise<void> {
    if (this.stopped === 0) this.stopped = 1;
  }
}

function createPiChatExtension(dependencies: Partial<PiChatDependencies> = {}) {
  return createProductionPiChatExtension({
    ...dependencies,
    createDirectory: dependencies.createDirectory ?? (() => new IdleDirectory()),
  });
}

class FailingDirectory extends IdleDirectory {
  override async start(): Promise<void> {
    this.started += 1;
    throw new Error("directory bootstrap unavailable");
  }
}

class IdleTransport implements ChatTransport {
  started = 0;
  stopped = 0;
  async start(_listener: Parameters<ChatTransport["start"]>[0], _signal?: AbortSignal): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    if (this.stopped === 0) this.stopped = 1;
  }
}

class FailingTransport extends IdleTransport {
  override async start(): Promise<void> {
    this.started += 1;
    throw new Error("bootstrap unavailable");
  }
}

class DelayedStopTransport extends IdleTransport {
  stopStarted = false;
  private releaseStop: (() => void) | undefined;
  override async stop(): Promise<void> {
    this.stopStarted = true;
    await new Promise<void>((resolve) => {
      this.releaseStop = resolve;
    });
    await super.stop();
  }
  finishStop(): void {
    this.releaseStop?.();
  }
}

class DelayedTransport extends IdleTransport {
  override async start(_listener: Parameters<ChatTransport["start"]>[0], signal?: AbortSignal): Promise<void> {
    this.started += 1;
    await new Promise<void>((_resolve, reject) => {
      if (!signal) return reject(new Error("missing owner signal"));
      const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

class ControlledStartTransport extends IdleTransport {
  private resolveStart: (() => void) | undefined;
  private rejectStart: ((error: Error) => void) | undefined;
  override async start(): Promise<void> {
    this.started += 1;
    await new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
  }
  finishStart(): void {
    this.resolveStart?.();
  }
  failStart(error: Error): void {
    this.rejectStart?.(error);
  }
}

class ObservableTransport extends IdleTransport {
  private listener: Parameters<ChatTransport["start"]>[0] | undefined;
  override async start(listener: Parameters<ChatTransport["start"]>[0]): Promise<void> {
    this.started += 1;
    this.listener = listener;
  }
  reportError(error: Error): void {
    this.listener?.onError(error);
  }
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Pi Chat state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-extension-"));
  try {
    await run(join(root, "pi-chat.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("registers /chat without notifying or creating settings at startup", async () => {
  await fixture(async (settingsPath) => {
    const mock = createMockPi();
    createPiChatExtension({ settingsPath })(mock.pi);
    assert.ok(mock.commands.has("chat"));
    const ctx = createMockContext({ hasUI: true, mode: "tui" });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    assert.deepEqual(ctx.notifications, []);
    await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  });
});

test("invalid settings block startup restore and remain unchanged", async () => {
  await fixture(async (settingsPath) => {
    const contents = "{invalid-restore";
    await writeFile(settingsPath, contents, "utf8");
    const transport = new IdleTransport();
    const mock = createMockPi();
    createPiChatExtension({ settingsPath, createTransport: () => transport })(mock.pi);
    const ctx = createMockContext({ hasUI: true, mode: "tui" });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    assert.equal(transport.started, 0);
    assert.match(ctx.notifications.map(({ message }) => message).join("\n"), /settings are invalid/u);
    assert.equal(await readFile(settingsPath, "utf8"), contents);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  });
});

test("rejects unsupported modes and malformed direct arguments before starting networking", async () => {
  await fixture(async (settingsPath) => {
    const transports: IdleTransport[] = [];
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => {
        const transport = new IdleTransport();
        transports.push(transport);
        return transport;
      },
    })(mock.pi);
    const command = mock.commands.get("chat");
    assert.ok(command);
    for (const mode of ["rpc", "print", "json"] as const) {
      const ctx = createMockContext({ hasUI: mode === "rpc", mode });
      await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
      await assert.rejects(Promise.resolve(command?.handler("#pi-dev", ctx.ctx)), /TUI mode/u);
    }
    const tui = createMockContext({ hasUI: true, mode: "tui" });
    await emit(mock, "session_start", { reason: "startup" }, tui.ctx);
    await command?.handler("unexpected trailing words", tui.ctx);
    assert.match(tui.notifications.at(-1)?.message ?? "", /Usage: \/chat/u);
    assert.equal(transports.length, 0);
  });
});

test("direct public join creates identity only after confirmation and shutdown cleans UI/network", async () => {
  await fixture(async (settingsPath) => {
    const transport = new IdleTransport();
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      randomBytes: (size) => Buffer.alloc(size, 7),
      createTransport: () => transport,
    })(mock.pi);
    const sessionManager = { getSessionId: () => "s", getBranch: () => [], getEntries: () => [] };
    const selected: string[][] = [];
    const confirmations: string[] = [];
    let opened = 0;
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      sessionManager,
      input: async () => "Mika",
      select: async (_title: string, options: string[]) => {
        selected.push(options);
        return options.find((option) => /Room dock/u.test(option));
      },
      confirm: async (_title: string, message: string) => {
        confirmations.push(message);
        return true;
      },
      custom: async (factory: unknown) => {
        opened += 1;
        let done = false;
        const component = (
          factory as (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: () => void,
          ) => { handleInput(data: string): void }
        )(
          { terminal: { rows: 24 }, requestRender() {} },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          () => {
            done = true;
          },
        );
        component.handleInput("\u001b");
        assert.equal(done, true);
        return undefined;
      },
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await mock.commands.get("chat")?.handler("#pi-dev", ctx.ctx);
    assert.equal(transport.started, 1);
    assert.equal(opened, 1);
    const saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.nickname, "Mika");
    assert.equal(typeof saved.identitySeed, "string");
    assert.equal(saved.widgetMode, "dock");
    const room = createPublicRoom("pi-dev");
    assert.deepEqual(saved.resume, {
      rooms: [{ id: room.id, kind: "public", slug: "pi-dev" }],
      activeRoomId: room.id,
      surface: "chat",
    });
    assert.equal(selected.length, 1);
    assert.match(confirmations.at(-1) ?? "", /Display: Room dock/u);
    assert.deepEqual(
      selected[0]?.map((option) => option.split(" — ", 1)[0]),
      ["Room dock", "Latest message", "Status only", "Hidden"],
    );
    assert.ok(ctx.widgets.has("chat"));
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
    assert.equal(transport.stopped, 1);
    assert.equal(ctx.widgets.get("chat"), undefined);
    assert.equal(ctx.statuses.get("chat"), undefined);
  });
});

test("a delayed transport load rejects a concurrent join in the same session", async () => {
  await fixture(async (settingsPath) => {
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 27).toString("base64url"),
        widgetMode: "count",
      },
      { settingsPath },
    );
    const transport = new IdleTransport();
    let releaseTransport: (() => void) | undefined;
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: async () => {
        await new Promise<void>((resolve) => {
          releaseTransport = resolve;
        });
        return transport;
      },
      createDirectory: () => new IdleDirectory(),
    })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => true,
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    const command = mock.commands.get("chat");
    assert.ok(command);
    const firstJoin = command.handler("#first-room", ctx.ctx);
    await waitFor(() => releaseTransport !== undefined);
    await assert.rejects(async () => command.handler("#second-room", ctx.ctx), /join is already in progress/u);
    releaseTransport?.();
    await firstJoin;
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
    assert.equal(transport.stopped, 1);
  });
});

test("public joins own a scoped directory advertiser while private joins do not", async () => {
  await fixture(async (settingsPath) => {
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 18).toString("base64url"),
        widgetMode: "count",
      },
      { settingsPath },
    );
    const directory = new IdleDirectory();
    const advertised: Array<string | undefined> = [];
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => new IdleTransport(),
      createDirectory: (options) => {
        advertised.push(options.advertisedSlug);
        return directory;
      },
    })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => true,
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await mock.commands.get("chat")?.handler("#pi-dev", ctx.ctx);
    await waitFor(() => directory.started === 1);
    assert.deepEqual(advertised, ["pi-dev"]);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
    assert.equal(directory.stopped, 1);
  });

  await fixture(async (settingsPath) => {
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 19).toString("base64url"),
        widgetMode: "count",
      },
      { settingsPath },
    );
    let directories = 0;
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => new IdleTransport(),
      createDirectory: () => {
        directories += 1;
        return new IdleDirectory();
      },
    })(mock.pi);
    const room = createPrivateRoom(Buffer.alloc(32, 20));
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (_title: string, options: string[]) => options.find((option) => option.startsWith("Join once")),
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await mock.commands.get("chat")?.handler(room.invite ?? "", ctx.ctx);
    assert.equal(directories, 0);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  });
});

test("directory startup failure cleans its resource without disconnecting public chat", async () => {
  await fixture(async (settingsPath) => {
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 27).toString("base64url"),
        widgetMode: "count",
      },
      { settingsPath },
    );
    const transport = new IdleTransport();
    const directory = new FailingDirectory();
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => transport,
      createDirectory: () => directory,
    })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => true,
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await mock.commands.get("chat")?.handler("#pi-dev", ctx.ctx);
    await waitFor(() => ctx.notifications.some(({ message }) => /directory bootstrap unavailable/u.test(message)));
    assert.equal(directory.stopped, 1);
    assert.equal(transport.stopped, 0);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
    assert.equal(transport.stopped, 1);
  });
});

test("directory loader failure leaves public chat connected and reports the failure", async () => {
  await fixture(async (settingsPath) => {
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 27).toString("base64url"),
        widgetMode: "count",
      },
      { settingsPath },
    );
    const transport = new IdleTransport();
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => transport,
      createDirectory: async () => {
        throw new Error("directory module unavailable");
      },
    })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => true,
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await mock.commands.get("chat")?.handler("#pi-dev", ctx.ctx);
    await waitFor(() => ctx.notifications.some(({ message }) => /directory module unavailable/u.test(message)));
    assert.equal(transport.stopped, 0);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
    assert.equal(transport.stopped, 1);
  });
});

test("disconnected room browsing stops its temporary directory after the menu closes", async () => {
  await fixture(async (settingsPath) => {
    const directory = new IdleDirectory();
    directory.result = {
      rooms: [{ slug: "pi-dev", estimatedParticipants: 2 }],
      partial: false,
    };
    const mock = createMockPi();
    createPiChatExtension({ settingsPath, createDirectory: () => directory })(mock.pi);
    let mainOpened = false;
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        if (!harness.isPiTuiKitScreen) return harness.result;
        const rendered = harness.render().join("\n");
        if (!mainOpened && /Browse public rooms/u.test(rendered)) {
          mainOpened = true;
          harness.handleInput("tui.select.confirm");
          await harness.waitForPending();
          return harness.result;
        }
        harness.handleInput("\u0003");
        return harness.result;
      },
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await mock.commands.get("chat")?.handler("", ctx.ctx);
    assert.equal(directory.browsed, 1);
    assert.equal(directory.stopped, 1);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  });
});

test("private direct joins remember only after explicit bearer-secret consent", async () => {
  const cases = [
    { choice: "Join and remember", joined: true, remembered: true },
    { choice: "Join once", joined: true, remembered: false },
    { choice: "Cancel", joined: false, remembered: false },
    { choice: undefined, joined: false, remembered: false },
  ] as const;
  for (const scenario of cases) {
    await fixture(async (settingsPath) => {
      await updateChatSettings(
        {
          nickname: "Mika",
          identitySeed: Buffer.alloc(32, 8).toString("base64url"),
          widgetMode: "count",
        },
        { settingsPath },
      );
      const before = await readFile(settingsPath, "utf8");
      const room = createPrivateRoom(Buffer.alloc(32, 19));
      const transport = new IdleTransport();
      let opened = 0;
      const mock = createMockPi();
      createPiChatExtension({ settingsPath, createTransport: () => transport })(mock.pi);
      const ctx = createMockContext({
        hasUI: true,
        mode: "tui",
        select: async (title: string, options: string[]) => {
          assert.match(title, /Private bearer invite.*restore this room/u);
          assert.deepEqual(
            options.map((option) => option.split(" — ", 1)[0]),
            ["Join and remember", "Join once", "Cancel"],
          );
          return scenario.choice ? options.find((option) => option.startsWith(scenario.choice)) : undefined;
        },
        custom: async () => {
          opened += 1;
          return undefined;
        },
      });
      await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
      await mock.commands.get("chat")?.handler(room.invite ?? "", ctx.ctx);
      assert.equal(transport.started, scenario.joined ? 1 : 0);
      assert.equal(opened, scenario.joined ? 1 : 0);
      const after = await readFile(settingsPath, "utf8");
      if (!scenario.joined || !scenario.remembered) assert.equal(after, before);
      else {
        const saved = JSON.parse(after) as Record<string, unknown>;
        assert.deepEqual(saved.resume, {
          rooms: [{ id: room.id, kind: "private", invite: room.invite }],
          activeRoomId: room.id,
          surface: "chat",
        });
      }
      await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
    });
  }
});

test("failed resume publication rolls back a newly joined room and preserves settings", async () => {
  await fixture(async (settingsPath) => {
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 10).toString("base64url"),
        widgetMode: "count",
      },
      { settingsPath },
    );
    const before = await readFile(settingsPath, "utf8");
    const transport = new IdleTransport();
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => transport,
      updateSettings: async (patch, options) => {
        if (Object.hasOwn(patch, "resume")) throw new Error("resume disk full");
        return updateChatSettings(patch, options);
      },
    })(mock.pi);
    const ctx = createMockContext({ hasUI: true, mode: "tui", confirm: async () => true });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await assert.rejects(Promise.resolve(mock.commands.get("chat")?.handler("#pi-dev", ctx.ctx)), /resume disk full/u);
    assert.equal(transport.started, 1);
    assert.equal(transport.stopped, 1);
    assert.equal(await readFile(settingsPath, "utf8"), before);
    assert.equal(ctx.widgets.get("chat"), undefined);
  });
});

test("leave-and-forget clears resume before disconnect and rolls back on save failure", async () => {
  for (const failClear of [false, true]) {
    await fixture(async (settingsPath) => {
      await updateChatSettings(
        {
          nickname: "Mika",
          identitySeed: Buffer.alloc(32, 11).toString("base64url"),
          widgetMode: "count",
        },
        { settingsPath },
      );
      const transport = new IdleTransport();
      let leaveAttempted = false;
      const mock = createMockPi();
      createPiChatExtension({
        settingsPath,
        createTransport: () => transport,
        updateSettings: async (patch, options) => {
          if (failClear && patch.resume === null) throw new Error("cannot forget room");
          return updateChatSettings(patch, options);
        },
      })(mock.pi);
      const ctx = createMockContext({
        hasUI: true,
        mode: "tui",
        confirm: async () => true,
        custom: async (factory: unknown) => {
          const harness = createCustomSelectorHarness(factory);
          if (!harness.isPiTuiKitScreen) {
            harness.handleInput("tui.select.cancel");
            return harness.result;
          }
          const rendered = harness.render().join("\n");
          if (/Leave and forget room\?/u.test(rendered)) {
            if (leaveAttempted) {
              harness.handleInput("\u0003");
              return harness.result;
            }
            leaveAttempted = true;
            harness.handleInput("tui.select.confirm");
            await harness.waitForPending();
            if (failClear && harness.result === undefined) harness.handleInput("\u0003");
            return harness.result;
          }
          if (leaveAttempted) {
            harness.handleInput("\u0003");
            return harness.result;
          }
          for (let index = 0; index < 10; index += 1) {
            if (harness.render().some((line) => /[→›].*Leave/u.test(line))) break;
            harness.handleInput("tui.select.down");
          }
          harness.handleInput("tui.select.confirm");
          await harness.waitForPending();
          return harness.result;
        },
      });
      await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
      const command = mock.commands.get("chat");
      await command?.handler("#pi-dev", ctx.ctx);
      await command?.handler("", ctx.ctx);
      const document = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      const stoppedBeforeShutdown = transport.stopped;
      const lastNotification = ctx.notifications.at(-1)?.message ?? "";
      await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
      assert.equal(Object.hasOwn(document, "resume"), failClear);
      assert.equal(stoppedBeforeShutdown, failClear ? 0 : 1);
      if (failClear) assert.match(lastNotification, /cannot forget room/u);
    });
  }
});

test("session start restores a remembered room and only reopens the remembered chat surface", async () => {
  for (const surface of ["chat", "pi"] as const) {
    await fixture(async (settingsPath) => {
      const room = createPublicRoom(`restore-${surface}`);
      await updateChatSettings(
        {
          nickname: "Mika",
          identitySeed: Buffer.alloc(32, 6).toString("base64url"),
          widgetMode: "dock",
          resume: {
            rooms: [{ id: room.id, kind: "public", slug: `restore-${surface}` }],
            activeRoomId: room.id,
            surface,
          },
        },
        { settingsPath },
      );
      const transport = new IdleTransport();
      let opened = 0;
      const mock = createMockPi();
      createPiChatExtension({ settingsPath, createTransport: () => transport })(mock.pi);
      const ctx = createMockContext({
        hasUI: true,
        mode: "tui",
        custom: async () => {
          opened += 1;
          return undefined;
        },
      });
      await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
      await waitFor(() => transport.started === 1);
      await waitFor(() => opened === (surface === "chat" ? 1 : 0));
      assert.ok(ctx.widgets.has("chat"));
      await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
      assert.equal(transport.stopped, 1);
      const saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      assert.equal(Reflect.get(saved.resume as object, "surface"), surface);
    });
  }
});

test("remembered private rooms restore without repeating bearer-secret consent", async () => {
  await fixture(async (settingsPath) => {
    const room = createPrivateRoom(Buffer.alloc(32, 22));
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 16).toString("base64url"),
        widgetMode: "count",
        resume: {
          rooms: [{ id: room.id, kind: "private", invite: room.invite ?? "" }],
          activeRoomId: room.id,
          surface: "pi",
        },
      },
      { settingsPath },
    );
    const transport = new IdleTransport();
    let selections = 0;
    const mock = createMockPi();
    createPiChatExtension({ settingsPath, createTransport: () => transport })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => {
        selections += 1;
        return undefined;
      },
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await waitFor(() => transport.started === 1);
    assert.equal(selections, 0);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  });
});

test("failed startup restore keeps its room and the menu retry opens chat", async () => {
  await fixture(async (settingsPath) => {
    const room = createPublicRoom("retry-saved");
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 12).toString("base64url"),
        widgetMode: "dock",
        resume: {
          rooms: [{ id: room.id, kind: "public", slug: "retry-saved" }],
          activeRoomId: room.id,
          surface: "chat",
        },
      },
      { settingsPath },
    );
    const before = await readFile(settingsPath, "utf8");
    const failed = new FailingTransport();
    const recovered = new IdleTransport();
    let transportIndex = 0;
    let opened = 0;
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => (transportIndex++ === 0 ? failed : recovered),
    })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (_title: string, options: string[]) => options.find((option) => /Retry/u.test(option)),
      custom: async () => {
        opened += 1;
        return undefined;
      },
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await waitFor(() => ctx.notifications.some(({ message }) => /bootstrap unavailable/u.test(message)));
    assert.equal(failed.started, 1);
    assert.equal(failed.stopped, 1);
    assert.equal(ctx.statuses.get("chat"), "chat: restore failed");
    assert.equal(await readFile(settingsPath, "utf8"), before);
    await mock.commands.get("chat")?.handler("", ctx.ctx);
    assert.equal(recovered.started, 1);
    assert.equal(opened, 1);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  });
});

test("session replacement aborts and drains a pending room restore without stale UI", async () => {
  await fixture(async (settingsPath) => {
    const room = createPublicRoom("replace-restore");
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 14).toString("base64url"),
        widgetMode: "dock",
        resume: {
          rooms: [{ id: room.id, kind: "public", slug: "replace-restore" }],
          activeRoomId: room.id,
          surface: "pi",
        },
      },
      { settingsPath },
    );
    const delayed = new DelayedTransport();
    const mock = createMockPi();
    createPiChatExtension({ settingsPath, createTransport: () => delayed })(mock.pi);
    const first = createMockContext({ hasUI: true, mode: "tui" });
    await emit(mock, "session_start", { reason: "startup" }, first.ctx);
    await waitFor(() => delayed.started === 1);
    assert.equal(first.statuses.get("chat"), "chat: restoring #replace-restore");
    const second = createMockContext({ hasUI: true, mode: "rpc" });
    await emit(mock, "session_start", { reason: "switch" }, second.ctx);
    assert.equal(delayed.stopped, 1);
    assert.equal(first.widgets.get("chat"), undefined);
    assert.equal(first.statuses.get("chat"), undefined);
    assert.equal(
      first.notifications.some(({ message }) => /could not restore/u.test(message)),
      false,
    );
    await emit(mock, "session_shutdown", { reason: "quit" }, second.ctx);
  });
});

test("a stale failed join cannot clear the replacement session widget renderer", async () => {
  await fixture(async (settingsPath) => {
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 28).toString("base64url"),
        widgetMode: "dock",
      },
      { settingsPath },
    );
    const staleTransport = new ControlledStartTransport();
    const replacementTransport = new ControlledStartTransport();
    let transportIndex = 0;
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => (transportIndex++ === 0 ? staleTransport : replacementTransport),
    })(mock.pi);
    const first = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => true,
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "startup" }, first.ctx);
    const command = mock.commands.get("chat");
    assert.ok(command);
    const staleJoin = command.handler("#stale-room", first.ctx);
    await waitFor(() => staleTransport.started === 1);

    const replacement = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => true,
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "switch" }, replacement.ctx);
    const replacementJoin = command.handler("#replacement-room", replacement.ctx);
    await waitFor(() => replacementTransport.started === 1);
    const widgetFactory = replacement.widgets.get("chat") as ((tui: unknown, theme: unknown) => unknown) | undefined;
    assert.ok(widgetFactory);
    let renderRequests = 0;
    widgetFactory(
      {
        terminal: { rows: 24 },
        requestRender() {
          renderRequests += 1;
        },
      },
      { fg: (_color: string, text: string) => text },
    );

    staleTransport.failStart(new Error("stale bootstrap failed"));
    await staleJoin;
    replacementTransport.finishStart();
    await replacementJoin;

    assert.ok(renderRequests > 0);
    await emit(mock, "session_shutdown", { reason: "quit" }, replacement.ctx);
  });
});

test("shutdown aborts an automatically reopened composer and drains restore ownership", async () => {
  await fixture(async (settingsPath) => {
    const room = createPublicRoom("shutdown-restore");
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 15).toString("base64url"),
        widgetMode: "dock",
        resume: {
          rooms: [{ id: room.id, kind: "public", slug: "shutdown-restore" }],
          activeRoomId: room.id,
          surface: "chat",
        },
      },
      { settingsPath },
    );
    const transport = new IdleTransport();
    let opened = 0;
    const mock = createMockPi();
    createPiChatExtension({ settingsPath, createTransport: () => transport })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        opened += 1;
        return createCustomSelectorHarness(factory).resultPromise;
      },
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await waitFor(() => opened === 1);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
    assert.equal(transport.stopped, 1);
    assert.equal(ctx.widgets.get("chat"), undefined);
    assert.equal(ctx.statuses.get("chat"), undefined);
  });
});

test("a slow stale shutdown cannot clear replacement-session ownership", async () => {
  await fixture(async (settingsPath) => {
    await updateChatSettings(
      {
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 17).toString("base64url"),
        widgetMode: "count",
      },
      { settingsPath },
    );
    const transport = new DelayedStopTransport();
    const replacementTransport = new ObservableTransport();
    let transportIndex = 0;
    const room = createPrivateRoom(Buffer.alloc(32, 23));
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      createTransport: () => (transportIndex++ === 0 ? transport : replacementTransport),
    })(mock.pi);
    const first = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (_title: string, options: string[]) => options.find((option) => option.startsWith("Join once")),
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "startup" }, first.ctx);
    await mock.commands.get("chat")?.handler(room.invite ?? "", first.ctx);
    const shutdown = emit(mock, "session_shutdown", { reason: "quit" }, first.ctx);
    await waitFor(() => transport.stopStarted);
    const second = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => true,
      custom: async () => undefined,
    });
    await emit(mock, "session_start", { reason: "switch" }, second.ctx);
    await mock.commands.get("chat")?.handler("#replacement-room", second.ctx);
    const widgetFactory = second.widgets.get("chat") as ((tui: unknown, theme: unknown) => unknown) | undefined;
    assert.ok(widgetFactory);
    let renderRequests = 0;
    widgetFactory(
      {
        terminal: { rows: 24 },
        requestRender() {
          renderRequests += 1;
        },
      },
      { fg: (_color: string, text: string) => text },
    );
    transport.finishStop();
    await shutdown;
    replacementTransport.reportError(new Error("replacement retry"));
    assert.ok(renderRequests > 0);
    await mock.commands.get("chat")?.handler("bad", second.ctx);
    assert.match(second.notifications.at(-1)?.message ?? "", /Usage: \/chat/u);
    await emit(mock, "session_shutdown", { reason: "quit" }, second.ctx);
  });
});

test("legacy identity settings without a display mode remain status-only without a new prompt", async () => {
  await fixture(async (settingsPath) => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        nickname: "Legacy",
        identitySeed: Buffer.alloc(32, 5).toString("base64url"),
        future: { keep: true },
      }),
      { mode: 0o600 },
    );
    const transport = new IdleTransport();
    const mock = createMockPi();
    createPiChatExtension({ settingsPath, createTransport: () => transport })(mock.pi);
    let selections = 0;
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => true,
      select: async () => {
        selections += 1;
        return undefined;
      },
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        harness.handleInput("tui.select.cancel");
        return harness.result;
      },
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await mock.commands.get("chat")?.handler("#pi-dev", ctx.ctx);
    assert.equal(transport.started, 1);
    assert.equal(selections, 0);
    const saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.widgetMode, undefined);
    assert.deepEqual(saved.future, { keep: true });
    const widgetFactory = ctx.widgets.get("chat") as
      | ((tui: unknown, theme: unknown) => { render(width: number): string[] })
      | undefined;
    assert.ok(widgetFactory);
    const widget = widgetFactory(
      { terminal: { rows: 24 }, requestRender() {} },
      { fg: (_color: string, text: string) => text },
    );
    assert.match(widget.render(80).join("\n"), /^chat ·/u);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  });
});

test("connected manager opens a full custom composer and retains its draft", async () => {
  await fixture(async (settingsPath) => {
    const transport = new IdleTransport();
    const customOptions: unknown[] = [];
    const renderedViews: string[][] = [];
    let opens = 0;
    const mock = createMockPi();
    createPiChatExtension({
      settingsPath,
      randomBytes: (size) => Buffer.alloc(size, 9),
      createTransport: () => transport,
    })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => "Mika",
      confirm: async () => true,
      select: async (_title: string, options: string[]) =>
        options.find((option) => /Room dock|Reply in|Open chat/u.test(option)),
      custom: async (factory: unknown, options?: unknown) => {
        customOptions.push(options);
        let done = false;
        const component = (
          factory as (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: () => void,
          ) => { render(width: number): string[]; handleInput(data: string): void }
        )(
          { terminal: { rows: 24 }, requestRender() {} },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          () => {
            done = true;
          },
        );
        renderedViews.push(component.render(60));
        if (opens === 0) component.handleInput("retained draft");
        opens += 1;
        component.handleInput("\u001b");
        assert.equal(done, true);
        return undefined;
      },
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    const command = mock.commands.get("chat");
    await command?.handler("#pi-dev", ctx.ctx);
    await command?.handler("", ctx.ctx);
    await command?.handler("", ctx.ctx);
    assert.equal(opens, 3);
    assert.match(renderedViews[0]?.join("\n") ?? "", /CHAT INPUT/u);
    assert.match(renderedViews[1]?.join("\n") ?? "", /retained draft/u);
    assert.deepEqual(customOptions, [undefined, undefined, undefined]);
    await waitFor(async () => {
      const saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      return Reflect.get(saved.resume as object, "surface") === "pi";
    });
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  });
});

test("cancelled first-use identity has no persistence or network side effects", async () => {
  await fixture(async (settingsPath) => {
    const transport = new IdleTransport();
    const mock = createMockPi();
    createPiChatExtension({ settingsPath, createTransport: () => transport })(mock.pi);
    const ctx = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => "Mika",
      select: async () => undefined,
      confirm: async () => true,
    });
    await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
    await mock.commands.get("chat")?.handler("#pi-dev", ctx.ctx);
    assert.equal(transport.started, 0);
    await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  });
});
