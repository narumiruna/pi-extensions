import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import type { RenderHost } from "./contracts.js";
import { canonicalKeyId, keysOverlap, usesDisambiguatedKeyProtocol } from "./key-matching.js";

// TuiAltScreen's input listener runs before replacement-component dispatch.
// Search next/previous/close are reserved only while the native search overlay
// has focus, when the replacement component does not own input at all.
const HOST_ACTIONS = [
  "tui.altScreen.search",
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.lineUp",
  "tui.altScreen.lineDown",
  "tui.altScreen.previousPrompt",
  "tui.altScreen.nextPrompt",
  "tui.altScreen.top",
  "tui.altScreen.bottom",
] as const;

export function componentKeyAvailable(tui: RenderHost, key: string) {
  const native = tui as RenderHost & Partial<Pick<TUI, "mode" | "onDebug">>;
  const canonical = canonicalKeyId(key);
  if (!canonical) return false;
  const host = getKeybindings();
  const reserved = native.mode === "fullscreen" ? HOST_ACTIONS.flatMap((action) => host.getKeys(action)) : [];
  if (native.onDebug) reserved.push("shift+ctrl+d");
  return !reserved.some((candidate) => {
    const other = canonicalKeyId(candidate);
    return other !== undefined && keysOverlap(canonical, other, usesDisambiguatedKeyProtocol(tui));
  });
}

/** Filter hints, not dispatch: Pi remains the authority for host input ownership. */
export function componentKeybindings<Bindings extends object>(tui: RenderHost, keybindings: Bindings): Bindings {
  return new Proxy(keybindings, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "getKeys" && typeof value === "function") {
        return (binding: string) =>
          (value as (binding: string) => readonly string[])
            .call(target, binding)
            .filter((key) => componentKeyAvailable(tui, key));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
