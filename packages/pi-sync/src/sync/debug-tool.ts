import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debugCheckFailure, summarizeDebugInspection } from "@narumitw/pi-sync-daemon/engine/debug-check";
import { readLatestDebugCheck } from "@narumitw/pi-sync-daemon/engine/debug-log";
import { Type } from "typebox";
import type { PiDaemonClient } from "../daemon/pi-client.js";
import { configFromSettings, syncCheckConfigFingerprint, syncConfigReviewFingerprint } from "../settings/config.js";
import { safeTerminalText } from "../ui/terminal-text.js";

const TOOL_NAME = "pi_sync_debug";
const RECHECK_TIMEOUT_MS = 30_000;
type DebugOwner = { client: PiDaemonClient; signal: AbortSignal };

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

export function registerPiSyncDebug(pi: ExtensionAPI, getOwner: (ctx: ExtensionContext) => DebugOwner | undefined) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Pi Sync debug",
    description:
      "Read the latest sanitized Pi Sync check, or ask for user confirmation to recheck the current setup without publishing or applying files.",
    parameters: Type.Object({ action: StringEnum(["latest", "recheck"]) }, { additionalProperties: false }),
    defaultActive: false,
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, { action }, toolSignal, _update, ctx) {
      const owner = getOwner(ctx);
      if (!owner || !ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc"))
        throw new Error("Pi Sync debug requires an interactive session started with Debug mode on.");
      const { client } = owner;
      const signal = toolSignal ? AbortSignal.any([owner.signal, toolSignal]) : owner.signal;
      const validate = () => {
        signal.throwIfAborted();
        if (getOwner(ctx)?.client !== client) throw new Error("Pi Sync session was replaced.");
        try {
          client.validateDebugTool();
        } catch {
          throw new Error("The Pi Sync debug session is no longer available.");
        }
      };
      async function readSetup() {
        validate();
        try {
          const { settings } = await client.readStartupSettings(signal);
          validate();
          if (settings) return configFromSettings(settings);
        } catch {
          validate();
        }
        throw new Error("The current Pi Sync setup is not available. Review /sync → Settings.");
      }
      const setup = await readSetup();
      validate();
      if (action === "latest") {
        const last = readLatestDebugCheck(client.root, syncConfigReviewFingerprint(setup));
        if (last.kind === "unavailable") throw new Error("The private Pi Sync debug log is unavailable.");
        if (last.kind === "no-record") return toolResult({ kind: "no-record" });
        return toolResult({ kind: "historical", ...last.check });
      }
      if (action !== "recheck") throw new Error("Choose latest or recheck.");
      if (client.ownershipCleanupRequired) throw new Error("Pi Sync needs recovery. Open /sync daemon status.");
      const fingerprint = syncCheckConfigFingerprint(setup);
      let accepted: boolean;
      try {
        accepted = await ctx.ui.confirm(
          "Recheck Pi Sync?",
          `Setup: ${safeTerminalText(setup.setupName)}\nStorage connection: ${safeTerminalText(setup.connectionName)}\nRead the configured remote to compare it with local sync state. Nothing will be published or applied. The model receives a summary without storage addresses or file paths.`,
          { signal },
        );
      } catch {
        validate();
        throw new Error("Pi Sync recheck requires an available confirmation UI.");
      }
      validate();
      if (!accepted) return toolResult({ kind: "declined" });
      const current = await readSetup();
      validate();
      if (fingerprint !== syncCheckConfigFingerprint(current))
        throw new Error("Pi Sync setup changed before recheck. Ask to recheck the new setup.");
      const deadline = AbortSignal.timeout(RECHECK_TIMEOUT_MS);
      const recheckSignal = AbortSignal.any([signal, deadline]);
      let result: unknown;
      try {
        result = await client.run(
          "inspect",
          { setup: setup.setupName, fingerprint, origin: "recheck" },
          recheckSignal,
          ctx,
        );
      } catch (error) {
        validate();
        const { reason } = debugCheckFailure(deadline.aborted ? deadline.reason : error);
        throw new Error(`Pi Sync recheck failed: ${reason}.`);
      }
      validate();
      if (deadline.aborted) throw new Error("Pi Sync recheck failed: timeout.");
      const latest = await readSetup();
      validate();
      if (fingerprint !== syncCheckConfigFingerprint(latest))
        throw new Error("Pi Sync setup changed during recheck. Ask to recheck the new setup.");
      const summary = summarizeDebugInspection(result);
      if (!summary) throw new Error("Pi Sync did not return a valid check result.");
      return toolResult({ kind: "fresh", time: new Date().toISOString(), origin: "recheck", summary });
    },
  });

  return (enabled: boolean) => {
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME) === enabled) return;
    pi.setActiveTools(enabled ? [...active, TOOL_NAME] : active.filter((name) => name !== TOOL_NAME));
  };
}
