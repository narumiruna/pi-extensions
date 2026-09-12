import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { consumeLaunchEnvelope, type FleetLaunchEnvelope, launchEnvelopeEnvironment } from "./launch-envelope.js";
import { createPiLauncher, type PiLauncher } from "./launcher.js";
import { type PiInvocation, resolvePiInvocation } from "./pi-invocation.js";
import {
  createGroup,
  DEFAULT_MESSAGE_TTL_MS,
  FLEET_PROTOCOL_VERSION,
  type FleetGroup,
  type FleetLocalPeerDescription,
  type FleetMessage,
  type FleetMessageMode,
  type FleetPeerDescription,
  formatInvite,
  MAX_MESSAGE_BYTES,
  parseInvite,
} from "./protocol.js";
import { putReloadHandoff, takeReloadHandoff } from "./reload-handoff.js";
import { FLEET_MESSAGE_TYPE, type FleetMessageDetails } from "./renderer.js";
import { createInMemoryFleetSettingsRuntime, type FleetSettingsRuntime } from "./settings.js";
import {
  createDefaultTerminalPort,
  createTerminalLaunchError,
  type FleetTerminal,
  type FleetTerminalPort,
  isTerminalLaunchError,
  normalizeTerminal,
  resolveTerminalPreference,
  type TerminalSplitDirection,
  terminalLabel,
} from "./terminal.js";
import { normalizeOptionalText, safeError, safeTerminalLine } from "./text.js";
import {
  type FleetDeliveryAck,
  type FleetDiscoveryIssue,
  type FleetDiscoveryResult,
  type FleetSendAuthorization,
  FleetTransport,
  type FleetTransportOptions,
} from "./transport.js";

const STATUS_KEY = "fleet";
const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const RELOAD_HANDOFF_TTL_MS = 30_000;

export interface FleetTransportPort {
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  listPeers(signal?: AbortSignal, deadlineMs?: number): Promise<FleetPeerDescription[]>;
  discover?(signal?: AbortSignal, deadlineMs?: number): Promise<FleetDiscoveryResult>;
  send(
    targetSessionId: string,
    message: FleetMessage,
    signal?: AbortSignal,
    authorization?: FleetSendAuthorization,
  ): Promise<FleetDeliveryAck>;
  setAcceptsRequests(value: boolean): void;
  readonly peerDescription: FleetPeerDescription;
  readonly endpointManifest:
    | {
        directory: string;
        socketPath: string;
        manifestPath: string;
      }
    | undefined;
}

export type { FleetTerminal, FleetTerminalPort } from "./terminal.js";

export interface FleetControllerDependencies {
  createTransport(options: FleetTransportOptions): FleetTransportPort;
  createTmux(): FleetTerminalPort;
  createGhostty(): FleetTerminalPort;
  createZellij(): FleetTerminalPort;
  resolveInvocation(args: string[]): PiInvocation;
  createLauncher(
    invocation: PiInvocation,
    directory: string,
    embeddedEnvironment?: Readonly<Record<string, string>>,
  ): Promise<PiLauncher>;
  realpath(value: string): Promise<string>;
  isDirectory(value: string): Promise<boolean>;
  now(): number;
  randomId(prefix: string): string;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  launchTimeoutMs: number;
  environment: NodeJS.ProcessEnv;
  runtimeBaseDirectory?: string;
}

export interface FleetSnapshot {
  connected: boolean;
  groupId?: string;
  invite?: string;
  acceptsRequests: boolean;
  self?: FleetPeerDescription;
  peers: FleetPeerDescription[];
  discoveryIssues?: FleetDiscoveryIssue[];
  discoverySaturated?: boolean;
}

export interface SpawnSessionInput {
  terminal?: FleetTerminal;
  direction?: TerminalSplitDirection;
  task?: string;
  name?: string;
  cwd?: string;
}

export interface SpawnSessionResult {
  sessionId: string;
  name?: string;
  cwd: string;
  terminal: FleetTerminal;
  terminalId: string;
  terminalVersion: string;
  ghosttyVersion?: string;
  kickoffAccepted: boolean;
}

interface Membership {
  group: FleetGroup;
  invite: string;
  acceptsRequests: boolean;
  launchId?: string;
  kickoffCapability?: string;
  kickoffConsumed: boolean;
  transport: FleetTransportPort;
  rollbackLaunch?: object;
}

export function defaultFleetControllerDependencies(pi: ExtensionAPI): FleetControllerDependencies {
  return {
    createTransport: (options) => new FleetTransport(options),
    createTmux: () => createDefaultTerminalPort(pi, "tmux"),
    createGhostty: () => createDefaultTerminalPort(pi, "ghostty"),
    createZellij: () => createDefaultTerminalPort(pi, "zellij"),
    resolveInvocation: (args) => resolvePiInvocation(args),
    createLauncher: (invocation, directory, embeddedEnvironment) =>
      createPiLauncher(invocation, directory, embeddedEnvironment),
    realpath,
    isDirectory: async (value) => (await stat(value)).isDirectory(),
    now: Date.now,
    randomId: (prefix) => `${prefix}_${randomBytes(16).toString("hex")}`,
    sleep: abortableSleep,
    launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
    environment: process.env,
  };
}

export class FleetController {
  private generation = 0;
  private activeSessionManager: object | undefined;
  private activeContext: ExtensionContext | undefined;
  private controller = new AbortController();
  private membership: Membership | undefined;
  private membershipMutation: Promise<void> = Promise.resolve();
  private readonly ownedTasks = new Set<Promise<unknown>>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly deps: FleetControllerDependencies = defaultFleetControllerDependencies(pi),
    private readonly settings: FleetSettingsRuntime = createInMemoryFleetSettingsRuntime(),
  ) {}

  async sessionStart(event: Pick<SessionStartEvent, "reason">, ctx: ExtensionContext): Promise<void> {
    if (this.activeSessionManager && this.activeSessionManager !== ctx.sessionManager) {
      await this.cleanupActive(false);
    }
    this.generation += 1;
    this.controller = new AbortController();
    this.activeSessionManager = ctx.sessionManager;
    this.activeContext = ctx;
    const owner = ctx.sessionManager;
    const ownerGeneration = this.generation;
    let envelope: FleetLaunchEnvelope | undefined;
    try {
      envelope = consumeLaunchEnvelope(this.deps.environment);
    } catch (error) {
      this.notify(ctx, `Pi Fleet ignored an invalid launch envelope: ${safeError(error)}`, "error");
    }
    try {
      const settings = await this.settings.reload(this.controller.signal);
      if (!this.isCurrent(owner, ownerGeneration)) return;
      if (settings.issue) this.notify(ctx, settings.issue.message, "warning");
    } catch (error) {
      if (!this.isCurrent(owner, ownerGeneration)) return;
      this.notify(ctx, `Pi Fleet could not load settings: ${safeError(error)}`, "error");
    }
    const handoff = event.reason === "reload" ? takeReloadHandoff(owner, this.deps.now()) : undefined;
    if (!envelope && !handoff) return;
    try {
      if (envelope?.childName) this.pi.setSessionName(envelope.childName);
      if (envelope?.model) {
        const model = ctx.modelRegistry.find(envelope.model.provider, envelope.model.id);
        if (!model) throw new Error("The requested parent model is unavailable in the child");
        if (!(await this.pi.setModel(model))) {
          throw new Error("The requested parent model could not be activated in the child");
        }
        if (!this.isCurrent(owner, ownerGeneration)) return;
        if (envelope.model.thinkingLevel) {
          this.pi.setThinkingLevel(envelope.model.thinkingLevel);
        }
      }
      const invite = envelope?.invite ?? handoff?.invite;
      if (!invite) return;
      await this.mutateMembership(() =>
        this.startGroupOwned(
          parseInvite(invite),
          invite,
          envelope?.acceptsRequests ?? handoff?.acceptsRequests ?? false,
          ctx,
          this.controller.signal,
          envelope?.launchId ?? handoff?.launchId,
          envelope?.kickoffCapability ?? handoff?.kickoffCapability,
          handoff?.kickoffConsumed ?? false,
        ),
      );
    } catch (error) {
      if (this.isCurrent(owner, ownerGeneration)) {
        this.notify(ctx, `Pi Fleet could not join the launch group: ${safeError(error)}`, "error");
        await this.leaveGroupInternal();
      }
    }
  }

  async sessionShutdown(event: Pick<SessionShutdownEvent, "reason">, ctx: ExtensionContext): Promise<void> {
    if (ctx.sessionManager !== this.activeSessionManager) return;
    if (event.reason === "reload" && this.membership) {
      putReloadHandoff(ctx.sessionManager, {
        invite: this.membership.invite,
        acceptsRequests: this.membership.acceptsRequests,
        ...(this.membership.launchId ? { launchId: this.membership.launchId } : {}),
        ...(this.membership.kickoffCapability ? { kickoffCapability: this.membership.kickoffCapability } : {}),
        kickoffConsumed: this.membership.kickoffConsumed,
        expiresAt: this.deps.now() + RELOAD_HANDOFF_TTL_MS,
      });
    }
    try {
      await this.cleanupActive(event.reason === "reload");
    } finally {
      this.clearStatus(ctx);
      await this.settings.flush();
    }
  }

  get sessionSignal(): AbortSignal {
    return this.controller.signal;
  }

  async startNewGroup(ctx: ExtensionContext, acceptsRequests: boolean, signal?: AbortSignal): Promise<FleetSnapshot> {
    this.assertCurrentContext(ctx);
    return this.mutateMembership(async () => {
      this.assertCurrentContext(ctx);
      if (this.membership) this.membership.rollbackLaunch = undefined;
      if (!this.membership) {
        const group = createGroup();
        await this.startGroupOwned(
          group,
          formatInvite(group.secret),
          acceptsRequests,
          ctx,
          combineSignals(signal, this.controller.signal),
        );
      }
      return this.snapshot(signal);
    });
  }

  async joinInvite(
    ctx: ExtensionContext,
    invite: string,
    acceptsRequests: boolean,
    signal?: AbortSignal,
  ): Promise<FleetSnapshot> {
    this.assertCurrentContext(ctx);
    const group = parseInvite(invite);
    return this.mutateMembership(async () => {
      this.assertCurrentContext(ctx);
      if (this.membership) {
        throw new Error("Leave the current Pi Fleet group before joining another");
      }
      await this.startGroupOwned(group, invite, acceptsRequests, ctx, combineSignals(signal, this.controller.signal));
      return this.snapshot(signal);
    });
  }

  async leave(ctx: ExtensionContext): Promise<void> {
    this.assertCurrentContext(ctx);
    await this.leaveGroupInternal();
  }

  setAcceptsRequests(ctx: ExtensionContext, value: boolean): void {
    this.assertCurrentContext(ctx);
    if (!this.membership) throw new Error("Pi Fleet is not connected");
    this.membership.rollbackLaunch = undefined;
    this.membership.acceptsRequests = value;
    this.membership.transport.setAcceptsRequests(value);
  }

  async snapshot(signal?: AbortSignal): Promise<FleetSnapshot> {
    if (!this.activeSessionManager || this.controller.signal.aborted) throw staleError();
    const membership = this.membership;
    if (!membership) return { connected: false, acceptsRequests: false, peers: [] };
    membership.rollbackLaunch = undefined;
    const owner = this.activeSessionManager;
    const ownerGeneration = this.generation;
    const operationSignal = combineSignals(signal, this.controller.signal);
    const discovery = membership.transport.discover
      ? await membership.transport.discover(operationSignal)
      : {
          peers: await membership.transport.listPeers(operationSignal),
          issues: [],
          scannedEntries: 0,
          saturated: false,
        };
    if (
      operationSignal.aborted ||
      this.membership !== membership ||
      !owner ||
      !this.isCurrent(owner, ownerGeneration)
    ) {
      throw staleError();
    }
    return {
      connected: true,
      groupId: membership.group.id,
      invite: membership.invite,
      acceptsRequests: membership.acceptsRequests,
      self: membership.transport.peerDescription,
      peers: discovery.peers,
      ...(discovery.issues.length > 0 ? { discoveryIssues: discovery.issues } : {}),
      ...(discovery.saturated ? { discoverySaturated: true } : {}),
    };
  }

  async send(
    ctx: ExtensionContext,
    options: {
      targetSessionId: string;
      text: string;
      mode: Exclude<FleetMessageMode, "kickoff">;
      replyTo?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ message: FleetMessage; acknowledgement: FleetDeliveryAck }> {
    this.assertCurrentContext(ctx);
    const membership = this.membership;
    if (!membership) throw new Error("Pi Fleet is not connected");
    membership.rollbackLaunch = undefined;
    if (Buffer.byteLength(options.text) > MAX_MESSAGE_BYTES) {
      throw new Error("Pi Fleet message is too large");
    }
    const self = membership.transport.peerDescription;
    const issuedAt = this.deps.now();
    const message: FleetMessage = {
      id: this.deps.randomId("msg"),
      fromSessionId: self.sessionId,
      ...(self.name ? { fromName: self.name } : {}),
      fromCwd: self.cwd,
      toSessionId: options.targetSessionId,
      mode: options.mode,
      text: options.text,
      issuedAt,
      expiresAt: issuedAt + DEFAULT_MESSAGE_TTL_MS,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    };
    const owner = ctx.sessionManager;
    const ownerGeneration = this.generation;
    const operationSignal = combineSignals(signal, this.controller.signal);
    const acknowledgement = await membership.transport.send(options.targetSessionId, message, operationSignal);
    if (operationSignal.aborted || this.membership !== membership || !this.isCurrent(owner, ownerGeneration)) {
      throw staleError();
    }
    return { message, acknowledgement };
  }

  spawn(ctx: ExtensionContext, input: SpawnSessionInput, signal?: AbortSignal): Promise<SpawnSessionResult> {
    return this.track(this.spawnOwned(ctx, input, signal));
  }

  private async spawnOwned(
    ctx: ExtensionContext,
    input: SpawnSessionInput,
    signal?: AbortSignal,
  ): Promise<SpawnSessionResult> {
    this.assertCurrentContext(ctx);
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
      throw new Error("session_spawn is supported only in TUI or RPC mode");
    }
    const owner = ctx.sessionManager;
    const ownerGeneration = this.generation;
    const operationSignal = combineSignals(signal, this.controller.signal);
    await this.settings.flush();
    if (!this.isCurrent(owner, ownerGeneration)) throw staleError();
    const launchSettings = this.settings.get().settings;
    const terminal =
      input.terminal !== undefined
        ? normalizeTerminal(input.terminal)
        : resolveTerminalPreference(launchSettings.defaultTerminal, this.deps.environment);
    const selectedTerminalLabel = terminalLabel(terminal);
    const direction = input.direction ?? "right";
    const cwd = await this.resolveSpawnCwd(ctx, input.cwd);
    if (!this.isCurrent(owner, ownerGeneration)) throw staleError();
    const task = normalizeOptionalText(input.task, "task", MAX_MESSAGE_BYTES);
    const launchId = this.deps.randomId("launch");
    const kickoffCapability = this.deps.randomId("kickoff");
    const name = normalizeOptionalText(input.name, "name", 200) ?? `Fleet ${launchId.slice(-6)}`;
    const terminalAdapter =
      terminal === "tmux"
        ? this.deps.createTmux()
        : terminal === "ghostty"
          ? this.deps.createGhostty()
          : this.deps.createZellij();
    const terminalVersion = await terminalAdapter.assertAvailable(operationSignal);
    if (!this.isCurrent(owner, ownerGeneration)) throw staleError();
    if (launchSettings.confirmSessionLaunch) {
      const confirmed = await ctx.ui.confirm(
        "Create a new Pi session?",
        [
          `${selectedTerminalLabel} split: ${direction}`,
          `Name: ${safeTerminalLine(name)}`,
          `Cwd: ${safeTerminalLine(cwd)}`,
          `Model: ${safeTerminalLine(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "Pi default")}`,
          "The child may spend model tokens and edit the same workspace concurrently.",
        ].join("\n"),
        { signal: operationSignal },
      );
      if (!this.isCurrent(owner, ownerGeneration)) throw staleError();
      if (!confirmed) throw abortError("Pi Fleet launch cancelled before creating a split");
    }
    const rollbackOwner = {};
    let claimedMembership: Membership | undefined;
    let splitCreated = false;
    let terminalId: string | undefined;
    let actualTerminalVersion = terminalVersion;
    let launcher: PiLauncher | undefined;
    const statusToken = this.beginStatus(ctx, `fleet: launching ${selectedTerminalLabel} split`);
    try {
      const membership = await this.claimSpawnMembership(ctx, operationSignal, rollbackOwner);
      claimedMembership = membership;
      const directory = membership.transport.endpointManifest?.directory;
      if (!directory) throw new Error("Pi Fleet runtime directory is unavailable");
      const invocation = this.deps.resolveInvocation(["--name", name]);
      const envelope: FleetLaunchEnvelope = {
        invite: membership.invite,
        parentSessionId: ctx.sessionManager.getSessionId(),
        launchId,
        kickoffCapability,
        childName: name,
        acceptsRequests: false,
        ...(ctx.model
          ? {
              model: {
                provider: ctx.model.provider,
                id: ctx.model.id,
                ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
              },
            }
          : {}),
      };
      const launchEnvironment = launchEnvelopeEnvironment(envelope);
      launcher = await this.deps.createLauncher(
        invocation,
        directory,
        terminal === "zellij" ? launchEnvironment : undefined,
      );
      if (!this.isCurrent(owner, ownerGeneration)) throw staleError();
      const split = await terminalAdapter.spawnSplit({
        direction,
        cwd,
        launcherCommand: launcher.command,
        environment: terminal === "zellij" ? {} : launchEnvironment,
        signal: operationSignal,
        isCurrent: () => this.isCurrent(owner, ownerGeneration),
      });
      splitCreated = true;
      terminalId = split.terminalId;
      actualTerminalVersion = split.version;
      this.updateStatus(statusToken, "fleet: waiting for child session");
      const child = await this.waitForChild(launchId, operationSignal, owner, ownerGeneration);
      let kickoffAccepted = false;
      if (task) {
        const self = membership.transport.peerDescription;
        const issuedAt = this.deps.now();
        const kickoff: FleetMessage = {
          id: this.deps.randomId("msg"),
          fromSessionId: self.sessionId,
          ...(self.name ? { fromName: self.name } : {}),
          fromCwd: self.cwd,
          toSessionId: child.sessionId,
          mode: "kickoff",
          text: task,
          issuedAt,
          expiresAt: issuedAt + DEFAULT_MESSAGE_TTL_MS,
          launchId,
        };
        const acknowledgement = await membership.transport.send(child.sessionId, kickoff, operationSignal, {
          kickoffCapability,
        });
        if (this.membership !== membership || !this.isCurrent(owner, ownerGeneration) || operationSignal.aborted) {
          throw staleError();
        }
        if (!acknowledgement.accepted) {
          throw createTerminalLaunchError(
            terminal,
            `${selectedTerminalLabel} created the split, but the child rejected its first task: ${safeTerminalLine(acknowledgement.error ?? "unknown reason")}`,
            true,
            terminalId,
          );
        }
        kickoffAccepted = true;
      }
      return {
        sessionId: child.sessionId,
        ...(child.name ? { name: child.name } : {}),
        cwd: child.cwd,
        terminal,
        terminalId,
        terminalVersion: actualTerminalVersion,
        ...(terminal === "ghostty" ? { ghosttyVersion: actualTerminalVersion } : {}),
        kickoffAccepted,
      };
    } catch (error) {
      const partial = splitCreated || (isTerminalLaunchError(error) && error.splitCreated);
      if (!partial && claimedMembership?.rollbackLaunch === rollbackOwner && this.membership === claimedMembership) {
        await this.leaveGroupInternal();
      }
      if (partial && !isTerminalLaunchError(error)) {
        throw createTerminalLaunchError(
          terminal,
          `${selectedTerminalLabel} created the split, but the child session did not become ready: ${safeError(error)}`,
          true,
          terminalId,
        );
      }
      throw error;
    } finally {
      if (claimedMembership?.rollbackLaunch === rollbackOwner) {
        claimedMembership.rollbackLaunch = undefined;
      }
      try {
        await launcher?.cleanup();
      } catch (error) {
        if (this.isCurrent(owner, ownerGeneration)) {
          this.notify(ctx, `Pi Fleet could not remove its temporary launcher: ${safeError(error)}`, "warning");
        }
      }
      this.endStatus(statusToken);
    }
  }

  isCurrent(ctx: ExtensionContext): boolean;
  isCurrent(owner: object, generation: number): boolean;
  isCurrent(owner: ExtensionContext | object, generation?: number): boolean {
    const sessionManager = "sessionManager" in owner ? owner.sessionManager : owner;
    return (
      this.activeSessionManager === sessionManager &&
      (generation === undefined || this.generation === generation) &&
      !this.controller.signal.aborted
    );
  }

  private claimSpawnMembership(ctx: ExtensionContext, signal: AbortSignal, rollbackOwner: object): Promise<Membership> {
    return this.mutateMembership(async () => {
      this.assertCurrentContext(ctx);
      if (this.membership) {
        this.membership.rollbackLaunch = undefined;
        return this.membership;
      }
      const group = createGroup();
      const membership = await this.startGroupOwned(group, formatInvite(group.secret), false, ctx, signal);
      membership.rollbackLaunch = rollbackOwner;
      return membership;
    });
  }

  private async startGroupOwned(
    group: FleetGroup,
    invite: string,
    acceptsRequests: boolean,
    ctx: ExtensionContext,
    signal: AbortSignal,
    launchId?: string,
    kickoffCapability?: string,
    kickoffConsumed = false,
  ): Promise<Membership> {
    this.assertCurrentContext(ctx);
    if (this.membership) {
      if (this.membership.group.id === group.id) return this.membership;
      throw new Error("Pi Fleet is already connected to another group");
    }
    const owner = ctx.sessionManager;
    const ownerGeneration = this.generation;
    const peer: FleetLocalPeerDescription = {
      protocolVersion: FLEET_PROTOCOL_VERSION,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(this.pi.getSessionName() ? { name: this.pi.getSessionName() } : {}),
      cwd: ctx.cwd,
      pid: process.pid,
      ...(launchId ? { launchId } : {}),
      acceptsRequests,
    };
    const recent = recentFleetState(ctx);
    let transport!: FleetTransportPort;
    let acceptedKickoff = kickoffConsumed || (launchId ? recent.consumedLaunchIds.has(launchId) : false);
    transport = this.deps.createTransport({
      group,
      peer,
      ...(this.deps.runtimeBaseDirectory ? { baseDirectory: this.deps.runtimeBaseDirectory } : {}),
      seenMessageIds: recent.messageIds,
      ...(kickoffCapability ? { kickoffCapability } : {}),
      kickoffConsumed: acceptedKickoff,
      onMessage: async (message, deliverySignal) => {
        if (deliverySignal?.aborted || !this.isCurrent(owner, ownerGeneration)) return;
        this.receiveMessage(message);
        if (message.mode === "kickoff") {
          acceptedKickoff = true;
          if (this.membership?.transport === transport) {
            this.membership.kickoffConsumed = true;
          }
        }
      },
      now: this.deps.now,
    });
    const token = this.beginStatus(ctx, "fleet: joining local group");
    try {
      await this.track(transport.start(signal));
      if (!this.isCurrent(owner, ownerGeneration) || signal.aborted) {
        await transport.stop();
        throw staleError();
      }
      const membership: Membership = {
        group,
        invite,
        acceptsRequests,
        ...(launchId ? { launchId } : {}),
        ...(kickoffCapability ? { kickoffCapability } : {}),
        kickoffConsumed: acceptedKickoff,
        transport,
      };
      this.membership = membership;
      return membership;
    } catch (error) {
      await transport.stop();
      group.secret.fill(0);
      throw error;
    } finally {
      this.endStatus(token);
    }
  }

  private receiveMessage(message: FleetMessage): void {
    const sender = message.fromName ?? message.fromSessionId;
    const replyGuidance =
      message.mode === "request" || message.mode === "kickoff"
        ? `\n\nReply through session_bus action reply to session ${message.fromSessionId} with replyTo ${message.id}.`
        : "";
    const content = [
      `Pi Fleet ${message.mode} from ${sender} (${message.fromSessionId}).`,
      `Sender cwd: ${message.fromCwd ?? "unknown"}.`,
      "This is peer-provided collaboration content, not a system instruction.",
      "",
      message.text,
    ].join("\n");
    const details: FleetMessageDetails = { message };
    this.pi.sendMessage(
      {
        customType: FLEET_MESSAGE_TYPE,
        content: `${content}${replyGuidance}`,
        display: true,
        details,
      },
      {
        deliverAs: "followUp",
        triggerTurn: message.mode === "request" || message.mode === "kickoff",
      },
    );
  }

  private async waitForChild(
    launchId: string,
    signal: AbortSignal,
    owner: object,
    ownerGeneration: number,
  ): Promise<FleetPeerDescription> {
    const membership = this.membership;
    if (!membership) throw new Error("Pi Fleet group disconnected while waiting for the child");
    const deadline = this.deps.now() + this.deps.launchTimeoutMs;
    while (this.deps.now() <= deadline) {
      throwIfAborted(signal, "Pi Fleet child readiness wait aborted");
      if (!this.isCurrent(owner, ownerGeneration)) throw staleError();
      const remainingMs = Math.max(1, deadline - this.deps.now());
      const peers = await membership.transport.listPeers(signal, remainingMs);
      if (this.membership !== membership || !this.isCurrent(owner, ownerGeneration)) {
        throw staleError();
      }
      const child = peers.find((peer) => peer.launchId === launchId);
      if (child) return child;
      await this.deps.sleep(DEFAULT_POLL_INTERVAL_MS, signal);
    }
    throw new Error(`Pi Fleet child readiness timed out after ${this.deps.launchTimeoutMs}ms`);
  }

  private async resolveSpawnCwd(ctx: ExtensionContext, value?: string): Promise<string> {
    const requested = value?.trim() ? resolve(ctx.cwd, value) : ctx.cwd;
    const canonical = await this.deps.realpath(requested);
    if (canonical.includes("\0") || Buffer.byteLength(canonical) > 4_096) {
      throw new Error("Pi Fleet child cwd is invalid or too large");
    }
    if (!(await this.deps.isDirectory(canonical))) {
      throw new Error("Pi Fleet child cwd must be an existing directory");
    }
    return canonical;
  }

  private assertCurrentContext(ctx: ExtensionContext): void {
    if (!this.isCurrent(ctx)) throw staleError();
  }

  private async cleanupActive(_reloading: boolean): Promise<void> {
    this.generation += 1;
    this.controller.abort();
    let cleanupError: unknown;
    try {
      await this.leaveGroupInternal();
    } catch (error) {
      cleanupError = error;
    }
    while (this.ownedTasks.size > 0) await Promise.allSettled([...this.ownedTasks]);
    if (this.activeContext) this.clearStatus(this.activeContext);
    this.activeContext = undefined;
    this.activeSessionManager = undefined;
    if (cleanupError) throw cleanupError;
  }

  private leaveGroupInternal(): Promise<void> {
    return this.mutateMembership(async () => {
      const membership = this.membership;
      this.membership = undefined;
      try {
        await membership?.transport.stop();
      } finally {
        membership?.group.secret.fill(0);
      }
    });
  }

  private mutateMembership<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.membershipMutation.then(operation, operation);
    this.membershipMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.ownedTasks.add(task);
    void task.then(
      () => this.ownedTasks.delete(task),
      () => this.ownedTasks.delete(task),
    );
    return task;
  }

  private beginStatus(ctx: ExtensionContext, text: string): { ctx: ExtensionContext; text: string } {
    const token = { ctx, text };
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // A replaced UI is allowed to reject best-effort cleanup.
    }
    return token;
  }

  private updateStatus(token: { ctx: ExtensionContext; text: string }, text: string): void {
    token.text = text;
    try {
      token.ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // A replaced UI is allowed to reject best-effort updates.
    }
  }

  private endStatus(token: { ctx: ExtensionContext; text: string }): void {
    try {
      token.ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // A replaced UI is allowed to reject best-effort cleanup.
    }
  }

  private clearStatus(ctx: ExtensionContext): void {
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // A replaced UI is allowed to reject best-effort cleanup.
    }
  }

  private notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      // Notification is best-effort during replacement.
    }
  }
}

function recentFleetState(ctx: ExtensionContext): {
  messageIds: string[];
  consumedLaunchIds: Set<string>;
} {
  const messageIds: string[] = [];
  const consumedLaunchIds = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch().slice(-1_024)) {
    if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== FLEET_MESSAGE_TYPE) {
      continue;
    }
    const details = entry.details;
    if (!isRecord(details) || !isRecord(details.message) || typeof details.message.id !== "string") {
      continue;
    }
    messageIds.push(details.message.id);
    if (details.message.mode === "kickoff" && typeof details.message.launchId === "string") {
      consumedLaunchIds.add(details.message.launchId);
    }
  }
  return { messageIds, consumedLaunchIds };
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const concrete = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return concrete.length === 0
    ? new AbortController().signal
    : concrete.length === 1
      ? concrete[0]
      : AbortSignal.any(concrete);
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal, "Pi Fleet wait aborted");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => finish(), milliseconds);
    const abort = () => finish(abortError("Pi Fleet wait aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw abortError(message);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function staleError(): Error {
  return new Error("Pi Fleet session is stale");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
