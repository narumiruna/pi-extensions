import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type BtwMainThreadUpdateSubscription = (listener: () => void) => () => void;
type SessionManager = ExtensionContext["sessionManager"];

export function registerBtwMainThreadUpdates(
  pi: ExtensionAPI,
): (sessionManager: SessionManager, listener: () => void) => () => void {
  const listeners = new WeakMap<SessionManager, Set<() => void>>();
  const notify = (ctx: ExtensionContext) => {
    for (const listener of listeners.get(ctx.sessionManager) ?? []) listener();
  };

  pi.on("session_info_changed", (_event, ctx) => notify(ctx));
  pi.on("session_compact", (_event, ctx) => notify(ctx));
  pi.on("session_tree", (_event, ctx) => notify(ctx));
  pi.on("agent_start", (_event, ctx) => notify(ctx));
  pi.on("agent_end", (_event, ctx) => notify(ctx));
  pi.on("agent_settled", (_event, ctx) => notify(ctx));
  pi.on("turn_start", (_event, ctx) => notify(ctx));
  pi.on("turn_end", (_event, ctx) => notify(ctx));
  pi.on("message_start", (_event, ctx) => notify(ctx));
  pi.on("message_update", (_event, ctx) => notify(ctx));
  pi.on("message_end", (_event, ctx) => notify(ctx));
  pi.on("tool_execution_start", (_event, ctx) => notify(ctx));
  pi.on("tool_execution_update", (_event, ctx) => notify(ctx));
  pi.on("tool_execution_end", (_event, ctx) => notify(ctx));
  pi.on("model_select", (_event, ctx) => notify(ctx));
  pi.on("thinking_level_select", (_event, ctx) => notify(ctx));

  return (sessionManager, listener) => {
    const active = listeners.get(sessionManager) ?? new Set<() => void>();
    active.add(listener);
    listeners.set(sessionManager, active);
    return () => {
      active.delete(listener);
      if (active.size === 0) listeners.delete(sessionManager);
    };
  };
}
