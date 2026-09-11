import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeGoalArguments, isRemovedQueueCommand, parseCommand } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import type { GoalRuntime } from "./runtime.js";

type GoalManagerModule = Pick<typeof import("./menu.js"), "showGoalManager">;
type GoalSettingsModule = Pick<typeof import("./settings-ui.js"), "showGoalSettings">;

export interface GoalCommandRegistrationOptions {
  settingsPath?: string;
  loadGoalManager?: () => Promise<GoalManagerModule>;
  loadGoalSettings?: () => Promise<GoalSettingsModule>;
}

export function registerGoalCommand(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  commands: GoalCommandController,
  options: GoalCommandRegistrationOptions = {},
) {
  const loadGoalManager = cachedModuleLoader(options.loadGoalManager ?? (() => import("./menu.js")));
  const loadGoalSettings = cachedModuleLoader(options.loadGoalSettings ?? (() => import("./settings-ui.js")));

  pi.registerCommand("goal", {
    description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
    getArgumentCompletions: (prefix) => completeGoalArguments(prefix),
    handler: async (args, ctx) => {
      if (runtime.hasLegacyQueueInterface() && isRemovedQueueCommand(args)) {
        reportRemovedQueueCommand(ctx, runtime);
        return;
      }
      const result = parseCommand(args);
      if (typeof result === "string") {
        reportCommandError(result, ctx);
        return;
      }
      if (result.kind === "show" && args.trim() === "") {
        const menuIsCurrent = captureMenuOwnership(runtime);
        let managerModule: GoalManagerModule;
        try {
          managerModule = await loadGoalManager();
        } catch (error) {
          if (!menuIsCurrent()) return;
          throw error;
        }
        if (!menuIsCurrent()) return;
        const { showGoalManager } = managerModule;
        await showGoalManager(runtime, commands, ctx, async (menuCtx, target) => {
          const settingsAreCurrent = captureMenuOwnership(runtime);
          let settingsModule: GoalSettingsModule;
          try {
            settingsModule = await loadGoalSettings();
          } catch (error) {
            if (!settingsAreCurrent()) return;
            throw error;
          }
          if (!settingsAreCurrent()) return;
          const { showGoalSettings } = settingsModule;
          await showGoalSettings(runtime, menuCtx, {
            settingsPath: options.settingsPath,
            initialScreen: target,
          });
        });
        return;
      }
      switch (result.kind) {
        case "show":
          commands.showGoal(ctx);
          return;
        case "pause":
          commands.pauseGoal(ctx);
          return;
        case "resume":
          await commands.resumeGoal(ctx);
          return;
        case "clear":
          commands.clearGoal(ctx);
          return;
        case "edit":
          await commands.editGoal(result.objective ?? "", result.tokenBudget, ctx);
          return;
        case "start":
          await commands.startGoal(result.objective ?? "", result.tokenBudget, ctx);
          return;
      }
    },
  });
}

function reportCommandError(message: string, ctx: ExtensionCommandContext) {
  const safeMessage = safeTerminalText(message);
  if (ctx.mode === "print" || ctx.mode === "json") throw new Error(safeMessage);
  notifyTerminal(ctx.ui, safeMessage, "warning");
}

function reportRemovedQueueCommand(ctx: ExtensionCommandContext, runtime: GoalRuntime) {
  const message = runtime.activeGoal
    ? "Ordered goal queue has been removed. Use /goal edit to reprioritize the active objective instead."
    : "Ordered goal queue has been removed. Start /goal <objectives> to continue with one merged objective, or use /goal clear to discard the old queue state.";
  if (ctx.mode === "print" || ctx.mode === "json") throw new Error(message);
  notifyTerminal(ctx.ui, message, "warning");
}

function captureMenuOwnership(runtime: GoalRuntime): () => boolean {
  const generation = runtime.menuGeneration;
  const controller = runtime.menuController;
  return () =>
    runtime.menuGeneration === generation && runtime.menuController === controller && !controller.signal.aborted;
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
