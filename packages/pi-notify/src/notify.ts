import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Coordinator } from "./coordinator.js";
import { displayPath } from "./metadata.js";
import { providers } from "./providers.js";
import { defaults, SettingsStore } from "./settings.js";

interface Owner {
  controller: AbortController;
  store: SettingsStore;
  coordinator: Coordinator;
  unsubscribe?: () => void;
  menu?: Promise<unknown>;
}

export default function notify(pi: ExtensionAPI): void {
  const owners = new Map<ExtensionContext["sessionManager"], Owner>();
  const current = (ctx: ExtensionContext) => owners.get(ctx.sessionManager);
  const stop = async (owner: Owner) => {
    owner.controller.abort();
    owner.unsubscribe?.();
    owner.unsubscribe = undefined;
    await Promise.allSettled([owner.coordinator.close(), owner.store.flush(), owner.menu]);
  };
  pi.on("session_start", async (_event, ctx) => {
    const previous = current(ctx);
    const controller = new AbortController();
    const store = new SettingsStore(
      join(getAgentDir(), "pi-notify.json"),
      ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "pi-notify.json") : undefined,
      providers,
    );
    const ui = ctx.ui;
    const hasUI = ctx.hasUI;
    const manager = ctx.sessionManager;
    const owner: Owner = {
      controller,
      store,
      coordinator: new Coordinator(defaults(), providers, ctx.mode === "tui", undefined, () => {
        if (owners.get(manager) === owner && !controller.signal.aborted && hasUI)
          ui.notify("Notification failed. Open /notify → Status for a safe error code.", "warning");
      }),
    };
    owners.set(manager, owner);
    if (previous) await stop(previous);
    if (controller.signal.aborted || owners.get(manager) !== owner) return;
    const snapshot = await store.load();
    if (controller.signal.aborted || owners.get(manager) !== owner) return;
    owner.coordinator.apply(snapshot.effective);
    if (ctx.mode === "tui") {
      // Public listeners run after Pi viewport input handling. Focus, mouse, and
      // viewport/search keys can be consumed first; this observes forwarded input only.
      owner.unsubscribe = ui.onTerminalInput((data) => {
        owner.coordinator.input(data);
      });
      owner.coordinator.observeActivity();
    }
    if (snapshot.diagnostics.length && hasUI) ui.notify(snapshot.diagnostics.join(" "), "warning");
  });
  pi.on("before_agent_start", (_event, ctx) => {
    current(ctx)?.coordinator.begin(true);
  });
  pi.on("agent_start", (_event, ctx) => {
    current(ctx)?.coordinator.begin();
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") current(ctx)?.coordinator.assistant(event.message.stopReason === "error");
  });
  pi.on("agent_settled", (event, ctx) => {
    current(ctx)?.coordinator.settle(event.aborted, {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionName: ctx.sessionManager.getSessionName(),
      cwd: ctx.cwd,
    });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const owner = current(ctx);
    if (!owner) return;
    owners.delete(ctx.sessionManager);
    await stop(owner);
  });
  pi.registerCommand("notify", {
    description: "Configure Telegram and Gotify notifications and inactivity reminders",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Usage: /notify (no arguments).");
      const owner = current(ctx);
      const path = owner?.store.userPath ?? join(getAgentDir(), "pi-notify.json");
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Notify setup requires TUI. Edit ${displayPath(path)} manually; inactivity mode delivers at settlement outside TUI.`,
            "info",
          );
          return;
        }
        throw new Error(
          "/notify setup requires TUI. Edit the user pi-notify.json file and reload; automatic delivery is independent of the menu.",
        );
      }
      if (!owner || owner.controller.signal.aborted) throw new Error("Notify session is unavailable. Reload Pi.");
      if (owner.menu) {
        ctx.ui.notify("Notify menu is already open.", "info");
        return;
      }
      const isCurrent = () => owners.get(ctx.sessionManager) === owner && !owner.controller.signal.aborted;
      const { showNotifyMenu } = await import("./menu.js");
      if (!isCurrent()) return;
      // Dynamic import can race a second invocation of this command.
      if (owner.menu) {
        ctx.ui.notify("Notify menu is already open.", "info");
        return;
      }
      const running = showNotifyMenu(ctx, {
        store: owner.store,
        coordinator: owner.coordinator,
        providers,
        signal: owner.controller.signal,
        isCurrent,
      });
      owner.menu = running;
      try {
        await running;
      } finally {
        if (owner.menu === running) owner.menu = undefined;
      }
    },
  });
}
