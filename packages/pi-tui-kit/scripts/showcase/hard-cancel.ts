import { getKeybindings, type TUI } from "@earendil-works/pi-tui";

// Fixed-key admission for these two repository demos, not a shortcut-availability API.
// TuiAltScreen handles search before overlay deferral; replacement components also
// yield to the viewport actions below. Match actual Ctrl+C input with Pi's matcher.
const VIEWPORT_ACTIONS = [
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

export function demoHasHardCancel(tui: Pick<TUI, "mode">, overlay: boolean): boolean {
  if (tui.mode !== "fullscreen") return true;
  const keys = getKeybindings();
  const actions = overlay ? (["tui.altScreen.search"] as const) : VIEWPORT_ACTIONS;
  return !actions.some((action) => keys.matches("\u0003", action) || keys.matches("\u001b[99;5u", action));
}

export const HARD_CANCEL_WARNING =
  "This demo needs Ctrl+C for hard cancellation. A native fullscreen binding owns it; restore that binding before reopening the demo.";
