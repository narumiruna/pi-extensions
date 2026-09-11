import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FleetController, type FleetControllerDependencies } from "./fleet-controller.js";
import type { FleetMenuSource } from "./menu.js";
import { parseInvite } from "./protocol.js";
import { FLEET_MESSAGE_TYPE, renderFleetMessage } from "./renderer.js";
import { createFleetSettingsRuntime, type FleetSettingsRuntime } from "./settings.js";
import { terminalLabel } from "./terminal.js";
import { safeError, safeTerminalLine } from "./text.js";
import { registerFleetTools } from "./tools.js";

const USAGE = "Usage: /fleet or /fleet <pifleet:v1:invite>";

type FleetMenuModule = Pick<typeof import("./menu.js"), "showFleetMenu">;

export interface PiFleetDependencies {
  controllerDependencies?: FleetControllerDependencies;
  settingsRuntime?: FleetSettingsRuntime;
  loadMenu?: () => Promise<FleetMenuModule>;
}

export function createPiFleetExtension(dependencies: PiFleetDependencies = {}): (pi: ExtensionAPI) => void {
  return function piFleetExtension(pi: ExtensionAPI): void {
    const settings = dependencies.settingsRuntime ?? createFleetSettingsRuntime();
    const controller = new FleetController(pi, dependencies.controllerDependencies, settings);
    const loadMenu = cachedModuleLoader(dependencies.loadMenu ?? (() => import("./menu.js")));

    pi.registerMessageRenderer(FLEET_MESSAGE_TYPE, renderFleetMessage);
    registerFleetTools(pi, controller);

    pi.on("session_start", async (event, ctx) => {
      await controller.sessionStart(event, ctx);
    });
    pi.on("session_shutdown", async (event, ctx) => {
      await controller.sessionShutdown(event, ctx);
    });

    pi.registerCommand("fleet", {
      description: "Spawn and connect local Pi sessions",
      handler: async (rawArgs, ctx) => {
        const args = rawArgs.trim();
        if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
          throw new Error(`Pi Fleet is unavailable in ${ctx.mode} mode. ${USAGE}`);
        }
        if (args) {
          await joinDirectInvite(controller, args, ctx);
          return;
        }
        const ownerSignal = controller.sessionSignal;
        const menuModule = await loadMenu();
        if (ownerSignal.aborted || !controller.isCurrent(ctx)) return;
        await menuModule.showFleetMenu(ctx, menuSource(controller, settings, ctx), {
          signal: ownerSignal,
          isCurrent: () => controller.isCurrent(ctx) && !ownerSignal.aborted,
        });
      },
    });
  };
}

async function joinDirectInvite(
  controller: FleetController,
  invite: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    parseInvite(invite);
  } catch {
    throw new Error(USAGE);
  }
  const signal = controller.sessionSignal;
  if (signal.aborted) return;
  const confirmed = await ctx.ui.confirm(
    "Join local Pi Fleet group?",
    "The bearer invite permits local peer messages. Incoming agent requests start blocked.",
    { signal },
  );
  if (!confirmed || signal.aborted || !controller.isCurrent(ctx)) return;
  await controller.joinInvite(ctx, invite, false, signal);
  if (controller.isCurrent(ctx)) {
    ctx.ui.notify("Joined the local Pi Fleet group.", "info");
  }
}

function menuSource(
  controller: FleetController,
  settings: FleetSettingsRuntime,
  ctx: ExtensionCommandContext,
): FleetMenuSource {
  return {
    snapshot: async (signal) => ({
      ...(await controller.snapshot(signal)),
      ...settings.get(),
      settingsPath: settings.getPath(),
    }),
    spawn: async (commandContext, input, signal) => {
      const result = await controller.spawn(commandContext, input, signal);
      if (controller.isCurrent(commandContext)) {
        const resultTerminalLabel = terminalLabel(result.terminal);
        commandContext.ui.notify(
          `Pi session ${safeTerminalLine(result.name ?? result.sessionId)} is ready in ${resultTerminalLabel}.`,
          "info",
        );
      }
    },
    start: async (commandContext, signal) => {
      await controller.startNewGroup(commandContext, false, signal);
      if (controller.isCurrent(commandContext)) {
        commandContext.ui.notify("Started a local Pi Fleet group.", "info");
      }
    },
    join: async (commandContext, invite, signal) => {
      try {
        await controller.joinInvite(commandContext, invite, false, signal);
      } catch (error) {
        throw new Error(`Could not join Pi Fleet: ${safeError(error)}`);
      }
    },
    send: async (commandContext, options, signal) => {
      const result = await controller.send(commandContext, options, signal);
      if (!result.acknowledgement.accepted) {
        throw new Error(
          `Target rejected the message: ${safeTerminalLine(result.acknowledgement.error ?? "unknown reason")}`,
        );
      }
      if (controller.isCurrent(commandContext)) {
        commandContext.ui.notify(
          `Target accepted ${safeTerminalLine(result.message.id)}. This does not prove task completion.`,
          "info",
        );
      }
    },
    updateSettings: async (patch) => {
      await settings.update(patch);
    },
    setAcceptsRequests: (value) => controller.setAcceptsRequests(ctx, value),
    leave: () => controller.leave(ctx),
  };
}

function cachedModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return async () => {
    if (!cached) {
      cached = load().catch((error) => {
        cached = undefined;
        throw error;
      });
    }
    return cached;
  };
}

export default createPiFleetExtension();
