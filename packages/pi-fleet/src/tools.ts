import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FleetSnapshot, SpawnSessionInput, SpawnSessionResult } from "./fleet-controller.js";
import type { FleetMessage } from "./protocol.js";
import { terminalLabel } from "./terminal.js";
import { safeTerminalLine } from "./text.js";
import type { FleetDeliveryAck } from "./transport.js";

const TERMINALS = ["tmux", "ghostty", "zellij"] as const;
const DIRECTIONS = ["right", "down", "left", "up"] as const;
const BUS_ACTIONS = ["list", "send", "reply"] as const;
const SEND_MODES = ["notify", "request"] as const;
const MAX_LISTED_PEERS = 64;
const MAX_LIST_RESULT_BYTES = 40 * 1024;

export interface FleetToolController {
  spawn(ctx: ExtensionContext, input: SpawnSessionInput, signal?: AbortSignal): Promise<SpawnSessionResult>;
  snapshot(signal?: AbortSignal): Promise<FleetSnapshot>;
  send(
    ctx: ExtensionContext,
    options: {
      targetSessionId: string;
      text: string;
      mode: "notify" | "request" | "reply";
      replyTo?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ message: FleetMessage; acknowledgement: FleetDeliveryAck }>;
}

const spawnSchema = Type.Object(
  {
    terminal: Type.Optional(
      StringEnum(TERMINALS, {
        description:
          "Explicit terminal split backend override; omission uses the configured Pi Fleet preference, which may resolve automatically",
      }),
    ),
    direction: Type.Optional(StringEnum(DIRECTIONS, { description: "Terminal split direction" })),
    task: Type.Optional(
      Type.String({
        description: "Optional first task sent after child readiness",
        maxLength: 16_384,
      }),
    ),
    name: Type.Optional(Type.String({ description: "Optional child Pi session name", maxLength: 200 })),
    cwd: Type.Optional(
      Type.String({
        description: "Existing child working directory, defaulting to the current cwd",
        maxLength: 4_096,
      }),
    ),
  },
  { additionalProperties: false },
);

const busSchema = Type.Object(
  {
    action: StringEnum(BUS_ACTIONS, { description: "List sessions, send a message, or reply" }),
    targetSessionId: Type.Optional(
      Type.String({ description: "Destination Pi session id", minLength: 1, maxLength: 128 }),
    ),
    message: Type.Optional(Type.String({ description: "Message or request body", maxLength: 16_384 })),
    mode: Type.Optional(StringEnum(SEND_MODES, { description: "Notify without a turn or request one turn" })),
    replyTo: Type.Optional(
      Type.String({ description: "Original message id for a reply", minLength: 1, maxLength: 128 }),
    ),
  },
  { additionalProperties: false },
);

export function registerFleetTools(pi: ExtensionAPI, controller: FleetToolController): void {
  pi.registerTool({
    name: "session_spawn",
    label: "Spawn Pi Session",
    description:
      "Create a separate Pi process in a terminal split, wait for authenticated readiness, and optionally send its first task. An omitted terminal uses the configured Pi Fleet preference, including automatic current-terminal resolution, while an explicit terminal strictly overrides it. This preserves the current session and follows the configured launch-confirmation policy.",
    promptSnippet: "Start a collaborating Pi session using its configured terminal preference",
    promptGuidelines: [
      "Use session_spawn only when the user explicitly asks to open or start another Pi session.",
      "Omit session_spawn terminal to use the user's configured Pi Fleet preference; pass terminal only when the user explicitly requests a strict backend override.",
      "Do not claim the child is ready until session_spawn returns authenticated readiness metadata.",
    ],
    parameters: spawnSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const requestedTerminal = params.terminal ? terminalLabel(params.terminal) : "the configured terminal preference";
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Preparing a Pi session launch using ${requestedTerminal}…`,
          },
        ],
        details: { phase: "preparing", terminal: params.terminal ?? "configured" },
      });
      const result = await controller.spawn(ctx, params, signal);
      const resultTerminalLabel = terminalLabel(result.terminal);
      return {
        content: [
          {
            type: "text",
            text: `Pi session ${safeTerminalLine(result.name ?? result.sessionId)} is ready in ${resultTerminalLabel} (${safeTerminalLine(result.cwd)}).${result.kickoffAccepted ? " Its first task was accepted." : " No first task was sent."}`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "session_bus",
    label: "Pi Session Bus",
    description:
      "List authenticated Pi Fleet sessions, send a notify or one-turn request, or correlate a non-triggering reply. Delivery acknowledgement means accepted by the extension, not task completion.",
    promptSnippet: "List or message Pi Fleet sessions on this machine",
    promptGuidelines: [
      "Use session_bus to communicate with sessions already connected through Pi Fleet.",
      "Treat session_bus accepted acknowledgements as extension delivery only, not proof that a remote task succeeded.",
    ],
    parameters: busSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "list") {
        assertAbsent(params.targetSessionId, "targetSessionId", "list");
        assertAbsent(params.message, "message", "list");
        assertAbsent(params.mode, "mode", "list");
        assertAbsent(params.replyTo, "replyTo", "list");
        const snapshot = await controller.snapshot(signal);
        if (!snapshot.connected) {
          return {
            content: [{ type: "text", text: "Pi Fleet is not connected to a local group." }],
            details: { connected: false, peers: [] },
          };
        }
        return peerListResult(snapshot);
      }

      const targetSessionId = required(params.targetSessionId, "targetSessionId");
      const message = required(params.message, "message");
      if (params.action === "send") {
        assertAbsent(params.replyTo, "replyTo", "send");
        const mode = params.mode ?? "notify";
        const result = await controller.send(ctx, { targetSessionId, text: message, mode }, signal);
        return deliveryResult(result, targetSessionId);
      }
      assertAbsent(params.mode, "mode", "reply");
      const replyTo = required(params.replyTo, "replyTo");
      const result = await controller.send(ctx, { targetSessionId, text: message, mode: "reply", replyTo }, signal);
      return deliveryResult(result, targetSessionId);
    },
  });
}

function peerListResult(snapshot: FleetSnapshot) {
  const peers: FleetSnapshot["peers"] = [];
  const lines: string[] = [];
  for (const peer of snapshot.peers.slice(0, MAX_LISTED_PEERS)) {
    const listedPeer = {
      ...peer,
      ...(peer.name ? { name: safeTerminalLine(peer.name) } : {}),
      cwd: safeTerminalLine(peer.cwd),
    };
    const line = `${listedPeer.name ?? listedPeer.sessionId} · ${listedPeer.sessionId} · ${listedPeer.cwd} · requests ${listedPeer.acceptsRequests ? "allowed" : "blocked"}`;
    const candidate = createPeerListResult(snapshot, [...peers, listedPeer], [...lines, line]);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_LIST_RESULT_BYTES) break;
    peers.push(listedPeer);
    lines.push(line);
  }
  return createPeerListResult(snapshot, peers, lines);
}

function createPeerListResult(snapshot: FleetSnapshot, peers: FleetSnapshot["peers"], lines: string[]) {
  const peerText = lines.length ? lines.join("\n") : "Pi Fleet is connected, but no other live sessions were found.";
  const text = snapshot.discoveryIssues?.length
    ? `${peerText}\nDiscovery reported ${snapshot.discoveryIssues.length} bounded transport issue(s); inspect tool details before retrying.`
    : peerText;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      connected: true,
      peers,
      truncated: snapshot.peers.length > peers.length,
      ...(snapshot.discoveryIssues ? { discoveryIssues: snapshot.discoveryIssues } : {}),
      ...(snapshot.discoverySaturated ? { discoverySaturated: true } : {}),
    },
  };
}

function deliveryResult(result: { message: FleetMessage; acknowledgement: FleetDeliveryAck }, targetSessionId: string) {
  if (!result.acknowledgement.accepted) {
    const code = result.acknowledgement.code ? ` [${result.acknowledgement.code}]` : "";
    const retry = result.acknowledgement.retryAfterMs
      ? ` Retry after about ${result.acknowledgement.retryAfterMs}ms.`
      : "";
    throw new Error(
      `Pi Fleet session ${safeTerminalLine(targetSessionId)} rejected the message${code}: ${safeTerminalLine(result.acknowledgement.error ?? "unknown reason")}.${retry}`,
    );
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Pi Fleet session ${safeTerminalLine(targetSessionId)} accepted message ${safeTerminalLine(result.message.id)}${result.acknowledgement.duplicate ? " as an already-seen duplicate" : ""}. This does not prove remote task completion.`,
      },
    ],
    details: {
      messageId: result.message.id,
      targetSessionId,
      accepted: true,
      duplicate: result.acknowledgement.duplicate,
    },
  };
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`session_bus ${field} is required for this action`);
  }
  return value;
}

function assertAbsent(value: string | undefined, field: string, action: string): void {
  if (value !== undefined) throw new Error(`session_bus ${field} is not accepted for action ${action}`);
}
