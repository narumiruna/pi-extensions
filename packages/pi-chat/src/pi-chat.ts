import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChatSnapshot, ChatTransport } from "./chat-session.js";
import { ChatSession } from "./chat-session.js";
import type { PublicRoomDirectory } from "./directory-network.js";
import { type ChatIdentity, createIdentity, deriveScopedIdentity, formatIdentityLabel } from "./identity.js";
import type { ChatMenuSource, JoinRoomOptions } from "./menu.js";
import { type HyperswarmTransportOptions, MAX_DIRECT_NEIGHBORS } from "./network-contract.js";
import { createPrivateRoom, createPublicRoom, parseInvite, type RoomDescriptor } from "./room.js";
import {
  awaitChatSettingsWrites,
  type ChatSettings,
  chatSettingsPath,
  descriptorFromRememberedRoom,
  readChatSettings,
  rememberedRoomFromDescriptor,
  updateChatSettings as updateChatSettingsFile,
  type WidgetMode,
} from "./settings.js";
import { sanitizeSingleLine } from "./text.js";

const CHAT_UI_KEY = "chat";
const USAGE = "Usage: /chat, /chat <pichat:v1-or-v2:invite>, or /chat #<public-slug>";
const PRIVATE_ROOM_OPTIONS = [
  "Join and remember — Save the bearer invite privately and restore this room",
  "Join once — Do not save the bearer invite",
  "Cancel",
] as const;
const DISPLAY_OPTIONS: ReadonlyArray<{ label: string; mode: WidgetMode }> = [
  {
    label: "Room dock — Show up to three recent messages above the Pi editor",
    mode: "dock",
  },
  { label: "Latest message — Show one recent message above the Pi editor", mode: "latest" },
  { label: "Status only — Hide message text", mode: "count" },
  { label: "Hidden — Show no persistent room widget", mode: "off" },
];

export interface PiChatDirectoryOptions {
  identity: ChatIdentity;
  advertisedSlug?: string;
}

type Awaitable<Value> = Value | Promise<Value>;
type ChatMenuModule = Pick<typeof import("./menu.js"), "showChatMenu">;
type ChatViewModule = Pick<typeof import("./chat-view.js"), "ChatView">;
type ChatWidgetModule = Pick<typeof import("./widget.js"), "renderChatWidget">;

export interface PiChatDependencies {
  settingsPath: string;
  randomBytes(size: number): Buffer;
  createTransport(options: HyperswarmTransportOptions): Awaitable<ChatTransport>;
  createDirectory(options: PiChatDirectoryOptions): Awaitable<PublicRoomDirectory>;
  updateSettings: typeof updateChatSettingsFile;
  loadChatMenu(): Promise<ChatMenuModule>;
  loadChatView(): Promise<ChatViewModule>;
  loadChatWidget(): Promise<ChatWidgetModule>;
}

export function createPiChatExtension(dependencies: Partial<PiChatDependencies> = {}): (pi: ExtensionAPI) => void {
  const loadNetwork = cachedModuleLoader(() => import("./network.js"));
  const loadDirectoryNetwork = cachedModuleLoader(() => import("./directory-network.js"));
  const deps: PiChatDependencies = {
    settingsPath: dependencies.settingsPath ?? chatSettingsPath(),
    randomBytes: dependencies.randomBytes ?? nodeRandomBytes,
    createTransport:
      dependencies.createTransport ??
      (async (options) => {
        const { HyperswarmTransport } = await loadNetwork();
        return new HyperswarmTransport(options);
      }),
    createDirectory:
      dependencies.createDirectory ??
      (async (options) => {
        const { HyperswarmDirectoryTransport, PublicRoomDirectorySession } = await loadDirectoryNetwork();
        return new PublicRoomDirectorySession({
          ...options,
          transport: new HyperswarmDirectoryTransport({ identity: options.identity }),
        });
      }),
    updateSettings: dependencies.updateSettings ?? updateChatSettingsFile,
    loadChatMenu: cachedModuleLoader(dependencies.loadChatMenu ?? (() => import("./menu.js"))),
    loadChatView: cachedModuleLoader(dependencies.loadChatView ?? (() => import("./chat-view.js"))),
    loadChatWidget: cachedModuleLoader(dependencies.loadChatWidget ?? (() => import("./widget.js"))),
  };
  const updateChatSettings = deps.updateSettings;

  return function piChatExtension(pi: ExtensionAPI): void {
    let generation = 0;
    let controller = new AbortController();
    let activeSessionManager: unknown;
    let activeContext: ExtensionContext | undefined;
    let settings: ChatSettings = {};
    let chatSession: ChatSession | undefined;
    let roomDirectory: PublicRoomDirectory | undefined;
    let latestSnapshot: ChatSnapshot | undefined;
    let chatDraft = "";
    let restoreError: string | undefined;
    let restoringRoomId: string | undefined;
    let joinOwner: { sessionManager: unknown; generation: number; token: symbol } | undefined;
    const ownedTasks = new Set<Promise<unknown>>();
    let renderChatWidget: ChatWidgetModule["renderChatWidget"] | undefined;
    let widgetRender: (() => void) | undefined;
    let widgetInstalled = false;

    const isCurrent = (owner: unknown, ownerGeneration: number) =>
      activeSessionManager === owner && generation === ownerGeneration && !controller.signal.aborted;

    const trackTask = <T>(task: Promise<T>): Promise<T> => {
      ownedTasks.add(task);
      void task.then(
        () => ownedTasks.delete(task),
        () => ownedTasks.delete(task),
      );
      return task;
    };

    const drainOwnedTasks = async (): Promise<void> => {
      while (ownedTasks.size > 0) await Promise.allSettled([...ownedTasks]);
    };

    const clearUi = (ctx: ExtensionContext, ownerGeneration = generation): void => {
      try {
        ctx.ui.setWidget(CHAT_UI_KEY, undefined);
        ctx.ui.setStatus(CHAT_UI_KEY, undefined);
      } catch {
        // Session replacement may invalidate an old UI immediately.
      }
      if (ctx.sessionManager !== activeSessionManager || generation !== ownerGeneration) return;
      renderChatWidget = undefined;
      widgetRender = undefined;
      widgetInstalled = false;
    };

    const updateUi = (ctx: ExtensionContext, snapshot?: ChatSnapshot): void => {
      if (ctx.sessionManager !== activeSessionManager) return;
      latestSnapshot = snapshot;
      try {
        ctx.ui.setStatus(
          CHAT_UI_KEY,
          snapshot?.state === "connecting"
            ? restoringRoomId === snapshot.room.id
              ? `chat: restoring ${sanitizeSingleLine(snapshot.room.label)}`
              : "chat: joining"
            : snapshot?.state === "degraded"
              ? "chat: reconnecting"
              : undefined,
        );
        const mode = settings.widgetMode ?? "count";
        if (ctx.mode !== "tui" || !snapshot || snapshot.state === "disconnected" || mode === "off") {
          ctx.ui.setWidget(CHAT_UI_KEY, undefined);
          widgetInstalled = false;
          widgetRender = undefined;
          return;
        }
        const renderWidget = renderChatWidget;
        if (!renderWidget) return;
        if (!widgetInstalled) {
          ctx.ui.setWidget(CHAT_UI_KEY, (tui, theme) => {
            const requestRender = () => tui.requestRender();
            widgetRender = requestRender;
            return {
              render: (width: number) =>
                latestSnapshot
                  ? renderWidget(latestSnapshot, settings.widgetMode ?? "count", width, theme, tui.terminal.rows)
                  : [],
              invalidate() {},
              dispose() {
                if (widgetRender === requestRender) widgetRender = undefined;
              },
            };
          });
          widgetInstalled = true;
        }
        widgetRender?.();
      } catch {
        // UI updates are best-effort after replacement.
      }
    };

    const disconnectRoom = async (): Promise<void> => {
      const owned = chatSession;
      const ownedDirectory = roomDirectory;
      const uiContext = activeContext;
      const uiGeneration = generation;
      chatSession = undefined;
      roomDirectory = undefined;
      latestSnapshot = undefined;
      chatDraft = "";
      await Promise.allSettled([owned?.leave(), ownedDirectory?.stop()]);
      if (uiContext) clearUi(uiContext, uiGeneration);
    };

    const ensureIdentity = async (
      ctx: ExtensionContext,
      signal: AbortSignal,
      owner: unknown,
      ownerGeneration: number,
    ): Promise<ChatIdentity | undefined> => {
      let nickname = settings.nickname;
      if (!nickname) {
        const entered = await ctx.ui.input(
          "Choose a Pi Chat nickname",
          "Visible to room peers; no OS or Git identity is used",
          { signal },
        );
        if (!isCurrent(owner, ownerGeneration) || signal.aborted || !entered) return undefined;
        nickname = entered;
      }
      let seed = settings.identitySeed;
      let widgetMode = settings.widgetMode;
      if (!seed) {
        const candidate = createIdentity(deps.randomBytes(32));
        if (!widgetMode) {
          const selected = await ctx.ui.select(
            "Joined room display",
            DISPLAY_OPTIONS.map(({ label }) => label),
            { signal },
          );
          if (!selected || !isCurrent(owner, ownerGeneration) || signal.aborted) return undefined;
          widgetMode = DISPLAY_OPTIONS.find(({ label }) => label === selected)?.mode;
          if (!widgetMode) return undefined;
        }
        const display = DISPLAY_OPTIONS.find(({ mode }) => mode === widgetMode)?.label ?? widgetMode;
        const confirmed = await ctx.ui.confirm(
          "Create Pi Chat identity?",
          `${formatIdentityLabel(nickname, candidate.publicKey)}\nDisplay: ${display}\nThis pseudonymous fingerprint is not real-world identity verification.`,
          { signal },
        );
        if (!confirmed || !isCurrent(owner, ownerGeneration) || signal.aborted) return undefined;
        seed = candidate.seed;
      }
      if (nickname !== settings.nickname || seed !== settings.identitySeed || widgetMode !== settings.widgetMode) {
        const updated = await updateChatSettings(
          {
            nickname,
            identitySeed: seed,
            ...(widgetMode ? { widgetMode } : {}),
          },
          { settingsPath: deps.settingsPath, signal },
        );
        if (!isCurrent(owner, ownerGeneration)) return undefined;
        settings = updated;
      }
      return createIdentity(Buffer.from(seed, "base64url"));
    };

    const startPublicRoomDirectory = (
      room: RoomDescriptor,
      identity: ChatIdentity,
      session: ChatSession,
      ctx: ExtensionContext,
      owner: unknown,
      ownerGeneration: number,
    ): void => {
      if (room.kind !== "public" || !room.slug) return;
      void trackTask(
        (async () => {
          let directory: PublicRoomDirectory | undefined;
          try {
            directory = await deps.createDirectory({
              identity: deriveScopedIdentity(identity, `directory:#${room.slug}`),
              advertisedSlug: room.slug,
            });
            if (!isCurrent(owner, ownerGeneration) || controller.signal.aborted || chatSession !== session) {
              await directory.stop();
              return;
            }
            roomDirectory = directory;
            await directory.start(controller.signal);
          } catch (error) {
            const ownsDirectory = !directory || roomDirectory === directory;
            if (directory && roomDirectory === directory) roomDirectory = undefined;
            if (directory) await Promise.allSettled([directory.stop()]);
            if (
              ownsDirectory &&
              isCurrent(owner, ownerGeneration) &&
              chatSession === session &&
              session.snapshot().room.id === room.id
            ) {
              notifySafely(
                ctx,
                `Pi Chat public-room discovery is unavailable: ${sanitizeSingleLine(
                  error instanceof Error ? error.message : String(error),
                )}. Chat remains connected.`,
                "warning",
              );
            }
          }
        })(),
      );
    };

    const joinRoomOwned = async (
      room: RoomDescriptor,
      ctx: ExtensionContext,
      signal: AbortSignal,
      options?: JoinRoomOptions,
    ): Promise<boolean> => {
      if (chatSession && latestSnapshot?.state !== "disconnected") {
        throw new Error("Leave the current Pi Chat room before joining another.");
      }
      const owner = ctx.sessionManager;
      const ownerGeneration = generation;
      if (!isCurrent(owner, ownerGeneration)) throw new Error("Pi Chat session is stale.");
      let remember = options?.remember ?? false;
      if (room.kind === "private" && options === undefined) {
        const selected = await ctx.ui.select(
          "Private bearer invite — restore this room after restarting Pi?",
          [...PRIVATE_ROOM_OPTIONS],
          { signal },
        );
        if (!selected || selected === PRIVATE_ROOM_OPTIONS[2] || !isCurrent(owner, ownerGeneration) || signal.aborted) {
          return false;
        }
        remember = selected === PRIVATE_ROOM_OPTIONS[0];
      }
      const identity = await ensureIdentity(ctx, signal, owner, ownerGeneration);
      if (!identity || !isCurrent(owner, ownerGeneration) || signal.aborted) return false;
      const nickname = settings.nickname;
      if (!nickname) throw new Error("Pi Chat nickname is unavailable.");
      const widgetModule = await loadOwnedModule(
        deps.loadChatWidget,
        () => isCurrent(owner, ownerGeneration) && !signal.aborted,
      );
      if (!widgetModule) return false;
      let transport: ChatTransport;
      try {
        transport = await deps.createTransport({
          room,
          identity,
          maxPeers: MAX_DIRECT_NEIGHBORS,
        });
      } catch (error) {
        if (!isCurrent(owner, ownerGeneration) || signal.aborted) return false;
        throw error;
      }
      if (!isCurrent(owner, ownerGeneration) || signal.aborted) {
        await transport.stop();
        return false;
      }
      renderChatWidget = widgetModule.renderChatWidget;
      const session = new ChatSession({
        room,
        identity,
        nickname,
        transport,
        onChange: (snapshot) => {
          if (chatSession !== session || !isCurrent(owner, ownerGeneration)) return;
          updateUi(ctx, snapshot);
        },
      });
      chatSession = session;
      ctx.ui.setStatus(CHAT_UI_KEY, "chat: joining");
      try {
        await session.start(AbortSignal.any([signal, controller.signal]));
        if (!isCurrent(owner, ownerGeneration) || chatSession !== session) {
          await session.leave();
          return false;
        }
        if (remember) {
          const rememberedRoom = rememberedRoomFromDescriptor(room);
          const next = await updateChatSettings(
            {
              resume: {
                rooms: [rememberedRoom],
                activeRoomId: rememberedRoom.id,
                surface: "chat",
              },
            },
            { settingsPath: deps.settingsPath, signal },
          );
          if (!isCurrent(owner, ownerGeneration) || chatSession !== session) {
            await session.leave();
            return false;
          }
          settings = next;
        }
        restoreError = undefined;
        latestSnapshot = session.snapshot();
        updateUi(ctx, latestSnapshot);
        startPublicRoomDirectory(room, identity, session, ctx, owner, ownerGeneration);
        return true;
      } catch (error) {
        if (chatSession === session) chatSession = undefined;
        await session.leave();
        clearUi(ctx, ownerGeneration);
        if (!signal.aborted && isCurrent(owner, ownerGeneration)) throw error;
        return false;
      }
    };

    const joinRoom: typeof joinRoomOwned = async (room, ctx, signal, options) => {
      const existing = joinOwner;
      if (existing?.sessionManager === ctx.sessionManager && existing.generation === generation) {
        throw new Error("A Pi Chat room join is already in progress.");
      }
      const token = Symbol("chat-join");
      joinOwner = { sessionManager: ctx.sessionManager, generation, token };
      try {
        return await joinRoomOwned(room, ctx, signal, options);
      } finally {
        if (joinOwner?.token === token) joinOwner = undefined;
      }
    };

    const updateRememberedSurface = async (
      surface: "chat" | "pi",
      ctx: ExtensionContext,
      owner: unknown,
      ownerGeneration: number,
      session: ChatSession,
    ): Promise<void> => {
      const resume = settings.resume;
      if (!resume || resume.activeRoomId !== session.snapshot().room.id || resume.surface === surface) {
        return;
      }
      try {
        const next = await updateChatSettings(
          { resume: { ...resume, surface } },
          { settingsPath: deps.settingsPath, signal: controller.signal },
        );
        if (isCurrent(owner, ownerGeneration) && chatSession === session) settings = next;
      } catch (error) {
        if (isCurrent(owner, ownerGeneration) && chatSession === session) {
          notifySafely(
            ctx,
            `Pi Chat could not save the restart view: ${sanitizeSingleLine(error instanceof Error ? error.message : String(error))}.`,
            "error",
          );
        }
      }
    };

    const openChat = async (ctx: ExtensionContext): Promise<void> => {
      const session = chatSession;
      if (!session || session.snapshot().state === "disconnected") {
        throw new Error("Join a Pi Chat room first.");
      }
      const owner = ctx.sessionManager;
      const ownerGeneration = generation;
      const ownerSignal = controller.signal;
      await updateRememberedSurface("chat", ctx, owner, ownerGeneration, session);
      if (!isCurrent(owner, ownerGeneration) || chatSession !== session) return;
      const viewModule = await loadOwnedModule(
        deps.loadChatView,
        () => isCurrent(owner, ownerGeneration) && chatSession === session,
      );
      if (!viewModule) return;
      const { ChatView } = viewModule;
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new ChatView({
            tui,
            theme,
            getSnapshot: () => session.snapshot(),
            send: (text) => session.send(text),
            initialDraft: chatDraft,
            onDraftChange: (text) => {
              if (isCurrent(owner, ownerGeneration) && chatSession === session) chatDraft = text;
            },
            setViewOpen: (open) => session.setViewOpen(open),
            subscribe: (listener) => session.subscribe(listener),
            signal: ownerSignal,
            onReturnToPi: () => {
              void trackTask(updateRememberedSurface("pi", ctx, owner, ownerGeneration, session));
            },
            onClose: () => done(undefined),
          }),
      );
      if (isCurrent(owner, ownerGeneration) && chatSession === session) updateUi(ctx, session.snapshot());
    };

    const restoreRememberedRoom = async (
      ctx: ExtensionContext,
      ownerGeneration: number,
      signal: AbortSignal = controller.signal,
    ): Promise<void> => {
      const resume = settings.resume;
      if (!resume || !settings.nickname || !settings.identitySeed || ctx.mode !== "tui") return;
      const remembered = resume.rooms.find(({ id }) => id === resume.activeRoomId);
      if (!remembered || !isCurrent(ctx.sessionManager, ownerGeneration)) return;
      let room: RoomDescriptor;
      try {
        room = descriptorFromRememberedRoom(remembered);
      } catch {
        notifySafely(ctx, "Pi Chat could not restore the saved room; fix pi-chat.json.", "error");
        return;
      }
      restoreError = undefined;
      restoringRoomId = room.id;
      try {
        ctx.ui.setStatus(CHAT_UI_KEY, `chat: restoring ${sanitizeSingleLine(room.label)}`);
        const joined = await joinRoom(room, ctx, signal, { remember: false });
        if (!joined || signal.aborted || !isCurrent(ctx.sessionManager, ownerGeneration)) return;
        if (resume.surface === "chat") await openChat(ctx);
      } catch (error) {
        if (isCurrent(ctx.sessionManager, ownerGeneration)) {
          restoreError = sanitizeSingleLine(error instanceof Error ? error.message : String(error));
          ctx.ui.setStatus(CHAT_UI_KEY, "chat: restore failed");
          notifySafely(
            ctx,
            `Pi Chat could not restore ${sanitizeSingleLine(room.label)}: ${restoreError}. Use /chat to retry or forget it.`,
            "error",
          );
        }
      } finally {
        if (restoringRoomId === room.id) restoringRoomId = undefined;
      }
    };

    const menuSource = (ctx: ExtensionCommandContext): ChatMenuSource => {
      const resetIdentity = createIdentity(deps.randomBytes(32));
      const owner = ctx.sessionManager;
      const ownerGeneration = generation;
      const ownsMenu = () => isCurrent(owner, ownerGeneration);
      return {
        settingsPath: deps.settingsPath,
        getSettings: () => settings,
        getSnapshot: () => chatSession?.snapshot(),
        getRestoreError: () => restoreError,
        createPrivateRoom: () => createPrivateRoom(deps.randomBytes(32)),
        browsePublicRooms: async (signal) => {
          if (!ownsMenu()) throw new Error("Pi Chat session is stale.");
          const activeDirectory = roomDirectory;
          const directory =
            activeDirectory ?? (await deps.createDirectory({ identity: createIdentity(deps.randomBytes(32)) }));
          const temporary = activeDirectory ? undefined : directory;
          const browseSignal = AbortSignal.any([signal, controller.signal]);
          if (!ownsMenu() || browseSignal.aborted) {
            if (temporary) await temporary.stop();
            throw browseSignal.reason ?? new DOMException("Aborted", "AbortError");
          }
          try {
            const result = await directory.browse(browseSignal);
            if (!ownsMenu() || browseSignal.aborted) {
              throw browseSignal.reason ?? new DOMException("Aborted", "AbortError");
            }
            return result;
          } finally {
            if (temporary) await temporary.stop();
          }
        },
        joinRoom,
        openChat: async (commandCtx) => {
          if (ownsMenu()) await openChat(commandCtx);
        },
        retryRememberedRoom: async (commandCtx, signal) => {
          if (!ownsMenu() || signal.aborted) return;
          await restoreRememberedRoom(commandCtx, ownerGeneration, AbortSignal.any([signal, controller.signal]));
          if (restoreError) throw new Error(restoreError);
        },
        forgetRememberedRoom: async (signal) => {
          if (!ownsMenu()) return;
          if (settings.resume) {
            const next = await updateChatSettings({ resume: null }, { settingsPath: deps.settingsPath, signal });
            if (!ownsMenu()) return;
            settings = next;
          }
          restoreError = undefined;
          clearUi(ctx);
        },
        leaveRoom: async (signal) => {
          if (!ownsMenu()) return;
          const currentRoomId = chatSession?.snapshot().room.id;
          if (settings.resume && settings.resume.activeRoomId === currentRoomId) {
            const next = await updateChatSettings({ resume: null }, { settingsPath: deps.settingsPath, signal });
            if (!ownsMenu()) return;
            settings = next;
          }
          restoreError = undefined;
          await disconnectRoom();
        },
        toggleMute(publicKey) {
          if (!ownsMenu() || !/^[0-9a-f]{64}$/u.test(publicKey)) return undefined;
          const muted = chatSession?.toggleMute(Buffer.from(publicKey, "hex"));
          if (chatSession) updateUi(ctx, chatSession.snapshot());
          return muted;
        },
        async updateNickname(value, signal) {
          const previous = settings;
          const next = await updateChatSettings({ nickname: value }, { settingsPath: deps.settingsPath, signal });
          if (!ownsMenu()) return;
          settings = next;
          try {
            chatSession?.updateNickname(value);
          } catch (error) {
            settings = previous;
            throw error;
          }
          if (chatSession) updateUi(ctx, chatSession.snapshot());
        },
        async updateWidgetMode(value, signal) {
          const next = await updateChatSettings({ widgetMode: value }, { settingsPath: deps.settingsPath, signal });
          if (!ownsMenu()) return;
          settings = next;
          updateUi(ctx, chatSession?.snapshot());
        },
        getIdentityResetPreview: () => {
          const current = settings.identitySeed
            ? formatIdentityLabel(
                settings.nickname ?? "anonymous",
                createIdentity(Buffer.from(settings.identitySeed, "base64url")).publicKey,
              )
            : "not created";
          return {
            current,
            next: formatIdentityLabel(settings.nickname ?? "anonymous", resetIdentity.publicKey),
          };
        },
        async resetIdentity(signal) {
          const next = await updateChatSettings(
            { identitySeed: resetIdentity.seed, resume: null },
            { settingsPath: deps.settingsPath, signal },
          );
          if (!ownsMenu()) return;
          settings = next;
          await disconnectRoom();
        },
      };
    };

    pi.registerCommand("chat", {
      description: "Open peer-to-peer developer chat",
      handler: async (args, ctx) => {
        if (ctx.mode !== "tui") throw new Error("Pi Chat requires Pi TUI mode.");
        const owner = ctx.sessionManager;
        const ownerGeneration = generation;
        if (!isCurrent(owner, ownerGeneration)) throw new Error("Pi Chat session is stale.");
        const input = args.trim();
        if (!input) {
          const menuModule = await loadOwnedModule(deps.loadChatMenu, () => isCurrent(owner, ownerGeneration));
          if (!menuModule) return;
          const { showChatMenu } = menuModule;
          await showChatMenu(ctx, menuSource(ctx), {
            signal: controller.signal,
            isCurrent: () => isCurrent(owner, ownerGeneration),
          });
          return;
        }
        if (/\s/u.test(input)) {
          notifySafely(ctx, USAGE, "warning");
          return;
        }
        let room: RoomDescriptor;
        let openAfterJoin = false;
        if (input.startsWith("pichat:")) {
          openAfterJoin = true;
          try {
            room = parseInvite(input);
          } catch {
            notifySafely(ctx, USAGE, "warning");
            return;
          }
        } else if (input.startsWith("#")) {
          openAfterJoin = true;
          try {
            room = createPublicRoom(input.slice(1));
          } catch {
            notifySafely(ctx, USAGE, "warning");
            return;
          }
          const confirmed = await ctx.ui.confirm(
            "Join public room?",
            "Anyone can join or record it. DHT and direct peers may observe network metadata.",
            { signal: controller.signal },
          );
          if (!confirmed || !isCurrent(owner, ownerGeneration)) return;
        } else {
          notifySafely(ctx, USAGE, "warning");
          return;
        }
        const joined = await joinRoom(
          room,
          ctx,
          controller.signal,
          room.kind === "public" ? { remember: true } : undefined,
        );
        if (joined && openAfterJoin && !controller.signal.aborted && isCurrent(owner, ownerGeneration)) {
          await openChat(ctx);
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      controller.abort(new DOMException("Pi Chat session replaced", "AbortError"));
      await disconnectRoom();
      await drainOwnedTasks();
      controller = new AbortController();
      generation += 1;
      activeSessionManager = ctx.sessionManager;
      activeContext = ctx;
      restoreError = undefined;
      clearUi(ctx);
      const ownerGeneration = generation;
      const loaded = await readChatSettings(deps.settingsPath);
      if (generation !== ownerGeneration || activeSessionManager !== ctx.sessionManager) return;
      if (loaded.kind === "loaded") settings = loaded.settings;
      else if (loaded.kind === "missing") settings = {};
      else {
        settings = {};
        notifySafely(ctx, "Pi Chat settings are invalid; fix the file before saving.", "error");
      }
      if (settings.resume && ctx.mode === "tui") {
        void trackTask(restoreRememberedRoom(ctx, ownerGeneration));
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const owner = ctx.sessionManager;
      if (owner !== activeSessionManager) return;
      controller.abort(new DOMException("Pi Chat session shut down", "AbortError"));
      const shutdownGeneration = ++generation;
      await disconnectRoom();
      await drainOwnedTasks();
      await awaitChatSettingsWrites(deps.settingsPath);
      if (activeSessionManager !== owner || generation !== shutdownGeneration) return;
      clearUi(ctx);
      activeSessionManager = undefined;
      activeContext = undefined;
    });
  };
}

function notifySafely(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(sanitizeSingleLine(message), level);
  } catch {
    // Stale UI errors must not escape lifecycle cleanup.
  }
}

async function loadOwnedModule<Module>(
  load: () => Promise<Module>,
  isCurrent: () => boolean,
): Promise<Module | undefined> {
  try {
    const module = await load();
    return isCurrent() ? module : undefined;
  } catch (error) {
    if (!isCurrent()) return undefined;
    throw error;
  }
}

function cachedModuleLoader<Module>(load: () => Promise<Module>): () => Promise<Module> {
  let pending: Promise<Module> | undefined;
  return () => {
    if (!pending) {
      pending = load().catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

export default createPiChatExtension();
