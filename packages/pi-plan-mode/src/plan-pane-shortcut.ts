import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { createInteractionInputGuard } from "./interaction-coordinator.js";

const KEY = "f4";
const INPUTS = ["\u001bOS", "\u001b[14~", "\u001b[[D", "\u001b[S", "\u001b[1;1S", "\u001b[14;1~", "\u001b[-24;1u"];

export function paneShortcutAvailable(bindings: Record<string, unknown>, planModeShortcut?: string): boolean {
  const reserved = [
    ...Object.values(bindings).flatMap((value) => (Array.isArray(value) ? value : [value])),
    planModeShortcut,
  ];
  return !reserved.some(
    (key) =>
      typeof key === "string" && INPUTS.some((input) => matchesKey(input, KEY) && matchesKey(input, key as KeyId)),
  );
}

export function createPlanPaneShortcut(pi: ExtensionAPI, toggle: (ctx: ExtensionContext) => void) {
  let registered: boolean | undefined;
  let input: { session: ExtensionContext["sessionManager"]; allowed: boolean; remove(): void } | undefined;

  function disposeSession() {
    const previous = input;
    input = undefined;
    previous?.remove();
  }

  return {
    disposeSession,
    startSession(ctx: ExtensionContext, planModeShortcut?: string) {
      disposeSession();
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      if (registered === undefined) {
        try {
          registered = paneShortcutAvailable(getKeybindings().getResolvedBindings(), planModeShortcut);
        } catch {
          registered = false;
        }
        if (registered) {
          pi.registerShortcut(KEY, {
            description: "Hide or show the Plan pane in fullscreen",
            handler: (shortcutCtx) => {
              if (input?.session === shortcutCtx.sessionManager && input.allowed) toggle(shortcutCtx);
            },
          });
        }
      }
      if (!registered) return;
      const permitsInput = createInteractionInputGuard();
      const owner = { session: ctx.sessionManager, allowed: false, remove: () => {} };
      owner.remove = ctx.ui.onTerminalInput((data) => {
        owner.allowed = permitsInput(data);
      });
      input = owner;
    },
  };
}
