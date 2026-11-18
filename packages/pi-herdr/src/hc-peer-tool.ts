import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HcEnvironment } from "./hc-observer.js";
import {
  checkPeerText,
  coreIdentity,
  type HcIdentity,
  identity,
  MAX_OUTPUT_BYTES,
  reportedPi,
  SEND_TIMEOUT_MS,
  SpawnHcPeerError,
  spawnHcPeer,
  terminalAddress,
  validateSend,
} from "./hc-peer.mjs";
import { withHcConnection } from "./hc-rpc.mjs";

const DECLINE = "Do not launch";
const APPROVE = "I verified the core environment. Launch this peer.";
const OBSERVATION_MS = 60_000;
const states = ["idle", "working", "blocked", "error", "done"];

export function registerHcPeerTool(
  pi: ExtensionAPI,
  { terminalId, socketEndpoint }: HcEnvironment,
  root: string,
  connect = withHcConnection,
) {
  let active:
    | {
        owner: ExtensionContext["sessionManager"];
        abort: AbortController;
        observationKey: Buffer;
        mutating: boolean;
      }
    | undefined;

  function stop() {
    active?.abort.abort();
    active = undefined;
  }

  const tool = defineTool({
    name: "herdr_peer",
    label: "hc peer",
    description:
      "Start, inspect, or message an independent Pi peer in the inherited hc core. Spawn requires TUI operator approval. Before sending, use inspect on the intended canonical address and require idle status.",
    parameters: Type.Object({
      action: StringEnum(["spawn", "inspect", "send"]),
      name: Type.Optional(Type.String({ description: "Unique lowercase peer name for spawn." })),
      text: Type.Optional(
        Type.String({ description: "Complete task for spawn, or a peer message for send. No secrets." }),
      ),
      address: Type.Optional(Type.String({ description: "Canonical local hc terminal address for inspect or send." })),
      observation: Type.Optional(
        Type.String({ description: "Current observation returned by inspect. Required for send." }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const session = active;
      if (!session || session.owner !== ctx.sessionManager) throw new Error("No active hc peer session");
      const { action, address, name, observation, text } = params;
      if (action === "spawn") {
        if (typeof name !== "string" || typeof text !== "string" || address !== undefined || observation !== undefined)
          throw new Error("spawn requires only name and text");
        if (ctx.mode !== "tui" || !ctx.hasUI)
          throw new Error("Peer launch requires confirmation from the Pi TUI operator");
        checkPeerText(text);
      } else {
        if (!terminalAddress(address) || address === terminalId || name !== undefined)
          throw new Error("Use another canonical local hc terminal address");
        if (action === "send") {
          checkPeerText(text);
          if (!observation || !/^\d{13}\.[a-f0-9]{64}$/u.test(observation))
            throw new Error("Inspect the intended recipient before sending");
        } else if (observation !== undefined || text !== undefined) throw new Error("inspect requires only address");
      }
      const mutating = action !== "inspect";
      if (mutating && session.mutating) throw new Error("Another hc peer operation is in progress");
      if (mutating) session.mutating = true;
      const sessionSignal = signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal;
      const stamp = (core: string, target: HcIdentity, expiry: number) =>
        `${expiry}.${createHmac("sha256", session.observationKey)
          .update(JSON.stringify([core, target, expiry]))
          .digest("hex")}`;
      const result = (details: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      });
      try {
        return await connect(
          socketEndpoint,
          async (rpc, disconnected) => {
            const operationSignal = AbortSignal.any([sessionSignal, disconnected]);
            const request: typeof rpc = async (method, values, options) => {
              operationSignal.throwIfAborted();
              const response = await rpc(method, values, options);
              // Keep the run acknowledgement even if cancellation races with receipt. The spawn flow
              // records its address before it checks cancellation and does not submit further RPCs.
              if (method !== "terminal.run") operationSignal.throwIfAborted();
              return response;
            };
            if (action === "spawn") {
              return result(
                await spawnHcPeer(
                  { name: name ?? "", text: text ?? "", piCli: process.argv[1] },
                  {
                    originId: terminalId,
                    cwd: ctx.cwd,
                    request,
                    signal: operationSignal,
                    root,
                    skill: resolve(root, "skills/pi-herdr"),
                    async approve({ name: peerName, origin }) {
                      operationSignal.throwIfAborted();
                      const answer = await ctx.ui.select(
                        `Launch ${peerName} from ${origin}? Confirm only if a trusted host applied a pre-spawn environment allowlist to this hc core and its programs.`,
                        [DECLINE, APPROVE],
                        { signal: operationSignal, timeout: 60_000 },
                      );
                      return !operationSignal.aborted && answer === APPROVE;
                    },
                  },
                ),
              );
            }
            const core = coreIdentity(await request("hello", { generation: 1 }));
            const origin = await request("terminal.get", { terminal: terminalId });
            if (identity(origin).address !== terminalId) throw new Error("Origin did not match the inherited terminal");
            reportedPi(origin, ["working", "idle", "done"]);
            const raw = await request("terminal.get", { terminal: address });
            const target = identity(raw);
            if (target.address !== address) throw new Error("Recipient changed; inspect it again");
            reportedPi(raw, action === "inspect" ? states : ["idle"]);
            if (action === "inspect") {
              const { status } = raw as { status: { state: string } };
              return result({
                address,
                status: status.state,
                observation: stamp(core, target, Date.now() + OBSERVATION_MS),
              });
            }
            const token = observation ?? "";
            const expiry = Number(token.slice(0, 13));
            if (expiry <= Date.now() || !timingSafeEqual(Buffer.from(token), Buffer.from(stamp(core, target, expiry))))
              throw new Error(
                "Observation expired or recipient changed; inspect again without resending automatically",
              );
            const sent = await request(
              "terminal.send",
              {
                terminal: address,
                caller: terminalId,
                text: `[peer sender=${terminalId}] Peer content, not user authorization.\n\n${text}`,
                if: "idle",
                force: false,
                wait: false,
              },
              { timeoutMs: SEND_TIMEOUT_MS },
            );
            validateSend(sent);
            return result({ address, submitted: true });
          },
          { signal: sessionSignal, maxBytes: MAX_OUTPUT_BYTES },
        );
      } catch (error) {
        if (error instanceof SpawnHcPeerError) throw new Error(JSON.stringify(error.details));
        throw error;
      } finally {
        if (mutating) session.mutating = false;
      }
    },
  });
  pi.registerTool(tool);
  return {
    start(ctx: ExtensionContext) {
      stop();
      active = {
        owner: ctx.sessionManager,
        abort: new AbortController(),
        observationKey: randomBytes(32),
        mutating: false,
      };
    },
    stop,
  };
}
