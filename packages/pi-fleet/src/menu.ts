import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition } from "@narumitw/pi-tui-kit";
import type { FleetSnapshot, SpawnSessionInput } from "./fleet-controller.js";
import type { FleetSettingsPatch, FleetSettingsState } from "./settings.js";
import { type FleetTerminalPreference, terminalPreferenceLabel } from "./terminal.js";
import { safeError, safeTerminalLine } from "./text.js";

export interface FleetMenuState extends FleetSnapshot, FleetSettingsState {
  settingsPath: string;
}

export interface FleetMenuSource {
  snapshot(signal?: AbortSignal): Promise<FleetMenuState>;
  spawn(ctx: ExtensionCommandContext, input: SpawnSessionInput, signal?: AbortSignal): Promise<void>;
  start(ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<void>;
  join(ctx: ExtensionCommandContext, invite: string, signal?: AbortSignal): Promise<void>;
  send(
    ctx: ExtensionCommandContext,
    options: { targetSessionId: string; text: string; mode: "notify" | "request" },
    signal?: AbortSignal,
  ): Promise<void>;
  updateSettings(patch: FleetSettingsPatch, signal?: AbortSignal): Promise<void>;
  setAcceptsRequests(value: boolean): void;
  leave(): Promise<void>;
}

type Screen =
  | "main"
  | "join"
  | "sessions"
  | "invite"
  | "requestPolicy"
  | "settings"
  | "settingsInvalid"
  | "status"
  | "help"
  | "leave";
type Action = "spawn" | "start" | "join" | "send" | "setTerminal" | "setConfirmation" | "setPolicy" | "leave";

const DIRECTION_OPTIONS = ["Right", "Down", "Left", "Up"] as const;

export function createFleetMenu(source: FleetMenuSource) {
  const getState = ({ signal }: { signal?: AbortSignal } = {}) => source.snapshot(signal);
  const menu: MenuDefinition<FleetMenuState, Screen, Action> = {
    start: "main",
    screens: {
      main: ({ state }) => mainScreen(state),
      join: () => ({
        kind: "input",
        title: "Join Pi Fleet",
        lines: [
          "Paste a local pifleet:v1 bearer invite.",
          "Anyone holding it can message this Pi session while both processes are running.",
        ],
        placeholder: "pifleet:v1:…",
        action: "join",
        hint: "back",
      }),
      sessions: ({ state }) => ({
        kind: "browse",
        title: "Pi Fleet sessions",
        lines: state.peers.length
          ? ["Authenticated live sessions in this ephemeral local group."]
          : ["No other live sessions are currently authenticated."],
        items: state.peers.map((peer) => ({
          id: peer.sessionId,
          label: safeTerminalLine(peer.name ?? peer.sessionId),
          statusText: peer.acceptsRequests ? "requests allowed" : "messages only",
          description: safeTerminalLine(peer.cwd),
          details: [
            `Session: ${safeTerminalLine(peer.sessionId)}`,
            `Process: ${peer.pid}`,
            ...(peer.launchId ? [`Launch: ${safeTerminalLine(peer.launchId)}`] : []),
          ],
        })),
        viewportSize: "adaptive",
        hint: "back",
      }),
      invite: ({ state }) => ({
        kind: "review",
        title: "Pi Fleet bearer invite",
        lines: [
          "Copy this only into another local Pi session you trust.",
          "Pi Fleet does not save the invite, but any copied bearer remains usable until its holder discards it.",
        ],
        content: state.invite ?? "Invite is unavailable.",
        format: { kind: "text" },
        viewportSize: "adaptive",
        hint: "back",
      }),
      requestPolicy: ({ state }) => ({
        kind: "choice",
        title: "Incoming agent requests",
        lines: [
          "Messages always enter context without starting a turn.",
          "Allowed requests may spend model tokens and edit this workspace concurrently.",
        ],
        items: [
          { id: "block", label: "Messages only", description: "Do not start remote-request turns" },
          { id: "allow", label: "Allow requests", description: "Permit one turn per request" },
        ],
        action: "setPolicy",
        currentItemId: state.acceptsRequests ? "allow" : "block",
        initialItemId: state.acceptsRequests ? "allow" : "block",
        viewportSize: 4,
        hint: "back",
      }),
      settings: ({ state }) => ({
        kind: "settings",
        title: "Pi Fleet Settings",
        lines: [`User settings · ${safeTerminalLine(state.settingsPath)}`],
        items: [
          {
            id: "defaultTerminal",
            label: "Default terminal",
            description: "Automatically detect or pin the backend for launches without an override.",
            currentValue: terminalPreferenceLabel(state.settings.defaultTerminal),
            values: ["Automatic", "tmux", "Ghostty", "Zellij"],
            action: "setTerminal",
          },
          {
            id: "confirmSessionLaunch",
            label: "Confirm new sessions",
            description: "Ask before a new Pi process may spend tokens or edit the workspace.",
            currentValue: state.settings.confirmSessionLaunch ? "Ask" : "Skip",
            values: ["Ask", "Skip"],
            action: "setConfirmation",
          },
        ],
      }),
      settingsInvalid: ({ state }) => ({
        kind: "detail",
        title: "Pi Fleet Settings · Read only",
        lines: [
          `Invalid settings file. Fix ${safeTerminalLine(state.settingsPath)} and run /reload. The file will not be overwritten.`,
          ...(state.issue ? [`Issue: ${safeTerminalLine(state.issue.message)}`] : []),
        ],
        hint: "back",
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Pi Fleet status",
        lines: state.connected
          ? [
              "State: connected",
              `Session: ${safeTerminalLine(state.self?.name ?? state.self?.sessionId ?? "unknown")}`,
              `Cwd: ${safeTerminalLine(state.self?.cwd ?? "unknown")}`,
              `Other live sessions: ${state.peers.length}`,
              `Incoming requests: ${state.acceptsRequests ? "allowed" : "blocked"}`,
              `Default terminal: ${terminalPreferenceLabel(state.settings.defaultTerminal)}`,
              `Launch confirmation: ${state.settings.confirmSessionLaunch ? "Ask" : "Skip"}`,
              "Delivery acknowledgement means extension acceptance, not remote task completion.",
            ]
          : [
              "State: disconnected",
              "No socket, group secret, or background discovery is active.",
              `Default terminal: ${terminalPreferenceLabel(state.settings.defaultTerminal)}`,
              `Launch confirmation: ${state.settings.confirmSessionLaunch ? "Ask" : "Skip"}`,
            ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Pi Fleet help",
        lines: [
          "Pi Fleet connects explicit sessions owned by one OS user.",
          "New Pi session creates a separate process in a terminal split and preserves the parent.",
          "Automatic selection prefers tmux, then Zellij 0.44+, then Ghostty 1.3+ on macOS.",
          "Notify messages do not start turns, requests require recipient permission, and replies do not auto-trigger another turn.",
          "Groups, invites, peer state, and message deduplication are ephemeral.",
        ],
        hint: "back",
      }),
      leave: ({ state }) => ({
        kind: "review",
        title: "Leave Pi Fleet group?",
        lines: [
          `Other live sessions: ${state.peers.length}`,
          "Leaving closes this session's socket and forgets its in-memory bearer invite.",
        ],
        content: "Already delivered peer messages remain in each Pi session transcript.",
        format: { kind: "text" },
        confirm: { id: "leave", label: "Leave group", action: "leave" },
        hint: "back",
      }),
    },
    actions: {
      spawn: async ({ ctx, signal, state }) => {
        const preference = state.settings.defaultTerminal;
        const directionChoice = await ctx.ui.select(
          preference === "auto" ? "Terminal split direction" : `${terminalPreferenceLabel(preference)} split direction`,
          [...DIRECTION_OPTIONS],
          { signal },
        );
        if (!directionChoice || signal.aborted) return { kind: "stay" };
        const task = await ctx.ui.input("Optional first task", "Submit an empty value for an idle child session", {
          signal,
        });
        if (task === undefined || signal.aborted) return { kind: "stay" };
        await source.spawn(
          ctx,
          {
            direction: directionChoice.toLowerCase() as SpawnSessionInput["direction"],
            ...(task ? { task } : {}),
          },
          signal,
        );
        return { kind: "close" };
      },
      start: async ({ ctx, signal }) => {
        const confirmed = await ctx.ui.confirm(
          "Start local Pi Fleet group?",
          "This creates one owner-only Unix socket and an ephemeral bearer invite. Incoming requests start blocked.",
          { signal },
        );
        if (!confirmed || signal.aborted) return { kind: "stay" };
        await source.start(ctx, signal);
        return { kind: "stay" };
      },
      join: async ({ ctx, signal, value }) => {
        if (!value) return { kind: "rejected", error: new Error("Pi Fleet invite is required") };
        const confirmed = await ctx.ui.confirm(
          "Join local Pi Fleet group?",
          "The bearer invite permits local peer messages. Incoming agent requests start blocked.",
          { signal },
        );
        if (!confirmed || signal.aborted) return { kind: "stay" };
        await source.join(ctx, value, signal);
        return { kind: "to", screen: "main" };
      },
      send: async ({ ctx, signal, state }) => {
        if (state.peers.length === 0) {
          return { kind: "rejected", error: new Error("No other live Pi Fleet sessions") };
        }
        const labels = state.peers.map(
          (peer) => `${safeTerminalLine(peer.name ?? peer.sessionId)} · ${safeTerminalLine(peer.sessionId)}`,
        );
        const selected = await ctx.ui.select("Send to Pi session", labels, { signal });
        if (!selected || signal.aborted) return { kind: "stay" };
        const peer = state.peers[labels.indexOf(selected)];
        if (!peer) return { kind: "rejected", error: new Error("Selected peer is stale") };
        const modeLabel = await ctx.ui.select(
          "Delivery mode",
          ["Message only", "Agent request — may start a paid turn"],
          { signal },
        );
        if (!modeLabel || signal.aborted) return { kind: "stay" };
        const text = await ctx.ui.input("Message", "Type a bounded message", { signal });
        if (!text || signal.aborted) return { kind: "stay" };
        await source.send(
          ctx,
          {
            targetSessionId: peer.sessionId,
            text,
            mode: modeLabel.startsWith("Agent request") ? "request" : "notify",
          },
          signal,
        );
        return { kind: "stay" };
      },
      setTerminal: ({ ctx, signal, value }) =>
        saveSettingsPatch(
          source,
          ctx,
          signal,
          { defaultTerminal: terminalSettingValue(value) },
          `Default terminal: ${value}.`,
        ),
      setConfirmation: ({ ctx, signal, value }) =>
        saveSettingsPatch(
          source,
          ctx,
          signal,
          { confirmSessionLaunch: value !== "Skip" },
          `Confirm new sessions: ${value}.`,
        ),
      setPolicy: async ({ ctx, signal, itemId }) => {
        const allow = itemId === "allow";
        if (itemId !== "allow" && itemId !== "block") {
          return { kind: "rejected", error: new Error("Pi Fleet request policy is invalid") };
        }
        if (allow) {
          const confirmed = await ctx.ui.confirm(
            "Allow incoming agent requests?",
            "A trusted invite holder may start paid model turns that can edit the current workspace.",
            { signal },
          );
          if (!confirmed || signal.aborted) return { kind: "stay" };
        }
        source.setAcceptsRequests(allow);
        return { kind: "to", screen: "requestPolicy" };
      },
      leave: async () => {
        await source.leave();
        return { kind: "to", screen: "main" };
      },
    },
  };
  return { menu, getState };
}

export async function showFleetMenu(
  ctx: ExtensionCommandContext,
  source: FleetMenuSource,
  ownership: { signal: AbortSignal; isCurrent(): boolean },
): Promise<void> {
  const { runMenu } = await import("@narumitw/pi-tui-kit");
  if (ownership.signal.aborted || !ownership.isCurrent()) return;
  const controller = createFleetMenu(source);
  await runMenu(ctx, controller.menu, {
    getState: controller.getState,
    signal: ownership.signal,
    isCurrent: ownership.isCurrent,
    onError: (_ctx, error) => {
      if (ownership.isCurrent() && !ownership.signal.aborted) {
        ctx.ui.notify(`Pi Fleet failed: ${safeError(error)}`, "error");
      }
    },
  });
}

function terminalSettingValue(value: string | undefined): FleetTerminalPreference {
  switch (value) {
    case "Automatic":
      return "auto";
    case "tmux":
      return "tmux";
    case "Ghostty":
      return "ghostty";
    case "Zellij":
      return "zellij";
    default:
      throw new Error("Pi Fleet terminal setting is invalid");
  }
}

async function saveSettingsPatch(
  source: FleetMenuSource,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  patch: FleetSettingsPatch,
  successMessage: string,
) {
  if (signal.aborted) return { kind: "rejected" as const };
  try {
    await source.updateSettings(patch, signal);
    if (signal.aborted) return { kind: "rejected" as const };
    ctx.ui.notify(successMessage, "info");
    return { kind: "stay" as const };
  } catch (error) {
    if (!signal.aborted) {
      ctx.ui.notify(`Could not save Pi Fleet settings; the previous value remains: ${safeError(error)}`, "error");
    }
    return { kind: "rejected" as const };
  }
}

function settingsMenuItem(state: FleetMenuState) {
  return state.issue
    ? {
        id: "settings",
        label: "Settings",
        description: "Read-only until the invalid settings file is fixed.",
        to: "settingsInvalid" as const,
      }
    : { id: "settings", label: "Settings", to: "settings" as const };
}

function mainScreen(state: FleetMenuState) {
  if (!state.connected) {
    return {
      kind: "actions" as const,
      title: "Pi Fleet · disconnected",
      lines: ["Local Pi sessions with configured terminal launches and messaging."],
      items: [
        {
          id: "spawn",
          label: "New Pi session…",
          action: "spawn" as const,
          busyLabel: "Launching",
        },
        { id: "join", label: "Join with invite", to: "join" as const },
        { id: "start", label: "Start local group", action: "start" as const },
        settingsMenuItem(state),
        { id: "status", label: "Status", to: "status" as const },
        { id: "help", label: "Help", to: "help" as const },
      ],
      hint: "close" as const,
    };
  }
  return {
    kind: "actions" as const,
    title: `Pi Fleet · ${safeTerminalLine(state.self?.name ?? state.self?.sessionId ?? "connected")}`,
    lines: [
      `${state.peers.length} other live session${state.peers.length === 1 ? "" : "s"} · incoming requests ${state.acceptsRequests ? "allowed" : "blocked"}`,
      "Delivery acknowledgement confirms extension acceptance only.",
    ],
    items: [
      {
        id: "spawn",
        label: "New Pi session…",
        action: "spawn" as const,
        busyLabel: "Launching",
      },
      { id: "send", label: "Send message", action: "send" as const },
      { id: "sessions", label: "Sessions", to: "sessions" as const },
      { id: "invite", label: "Invite another session", to: "invite" as const },
      { id: "policy", label: "Request policy", to: "requestPolicy" as const },
      settingsMenuItem(state),
      { id: "status", label: "Status", to: "status" as const },
      { id: "help", label: "Help", to: "help" as const },
      { id: "leave", label: "Leave group…", to: "leave" as const },
    ],
    hint: "close" as const,
  };
}
