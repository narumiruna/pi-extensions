import { spawn } from "node:child_process";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  isKittyProtocolActive,
  Key,
  type KeybindingsManager,
  parseKey,
  type ScrollView,
  type TUI,
  TuiAltScreen,
  type TuiInputListener,
  type TuiInputListenerResult,
  type TuiStopOptions,
} from "@earendil-works/pi-tui";
import { formatKeyLabel, sanitizeSingleLine } from "./text.js";

export type BtwFullscreenTui = TUI & {
  flash?: (message: string, durationMs?: number) => void;
  setLayoutRoot(component: Component | undefined): void;
  hasFocusedOverlay?(): boolean;
  addInputListenerBeforeAll?(listener: TuiInputListener): () => void;
  addInputListenerBeforeViewport?(listener: TuiInputListener): () => void;
  setViewportTarget?(scrollView: ScrollView | undefined): void;
};

type BtwInputListeners = {
  beforeAll: Set<TuiInputListener>;
  beforeViewport: Set<TuiInputListener>;
  regular: Set<TuiInputListener>;
};

const btwInputListeners = new WeakMap<BtwTuiAltScreen, BtwInputListeners>();

function dispatchBtwInput(listeners: BtwInputListeners, data: string): TuiInputListenerResult {
  let current = data;
  for (const group of [listeners.beforeAll, listeners.beforeViewport, listeners.regular]) {
    for (const listener of group) {
      const result = listener(current);
      if (result?.consume) return result;
      if (result?.data !== undefined) current = result.data;
    }
  }
  return current === data ? undefined : { data: current };
}

class BtwTuiAltScreen extends TuiAltScreen {
  private terminalActive = false;

  protected override beforeTerminalStart(): void {
    super.beforeTerminalStart();
    this.terminalActive = true;
  }

  protected override beforeTerminalStop(options: TuiStopOptions): void {
    this.terminalActive = false;
    super.beforeTerminalStop(options);
  }

  override flash(message: string, durationMs?: number): void {
    // Native clipboard callbacks cannot be cancelled. A late result must not
    // create flash timers or redraw the terminal after ownership has moved.
    if (this.terminalActive) super.flash(message, durationMs);
  }

  hasFocusedOverlay(): boolean {
    return this.isOverlayFocused();
  }

  setViewportTarget(scrollView: ScrollView | undefined): void {
    const layout: unknown = Reflect.get(this, "currentLayout");
    if (layout === undefined) return;
    if (typeof layout !== "object" || layout === null || !Reflect.set(layout, "primaryScrollView", scrollView)) {
      throw new Error("Pi BTW cannot route this fullscreen layout; update Pi.");
    }
  }

  override addInputListener(listener: TuiInputListener): () => void {
    let listeners = btwInputListeners.get(this);
    if (!listeners) {
      const registeredListeners: BtwInputListeners = {
        beforeAll: new Set(),
        beforeViewport: new Set(),
        regular: new Set(),
      };
      btwInputListeners.set(this, registeredListeners);
      super.addInputListener((data) => dispatchBtwInput(registeredListeners, data));
      listeners = registeredListeners;
    }
    listeners.regular.add(listener);
    return () => listeners.regular.delete(listener);
  }

  addInputListenerBeforeAll(listener: TuiInputListener): () => void {
    const listeners = btwInputListeners.get(this);
    if (!listeners) return super.addInputListener(listener);
    listeners.beforeAll.add(listener);
    return () => listeners.beforeAll.delete(listener);
  }

  addInputListenerBeforeViewport(listener: TuiInputListener): () => void {
    const listeners = btwInputListeners.get(this);
    if (!listeners) return super.addInputListener(listener);
    listeners.beforeViewport.add(listener);
    return () => listeners.beforeViewport.delete(listener);
  }

  override removeInputListener(listener: TuiInputListener): void {
    const listeners = btwInputListeners.get(this);
    if (!listeners) {
      super.removeInputListener(listener);
      return;
    }
    listeners.beforeAll.delete(listener);
    listeners.beforeViewport.delete(listener);
    listeners.regular.delete(listener);
  }
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

// TuiAltScreen evaluates these actions before bottom, so shared keys cannot jump to latest.
const ALT_SCREEN_ACTIONS_BEFORE_BOTTOM = [
  "tui.altScreen.search",
  "tui.altScreen.searchNext",
  "tui.altScreen.searchPrevious",
  "tui.altScreen.searchClose",
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.lineUp",
  "tui.altScreen.lineDown",
  "tui.altScreen.previousPrompt",
  "tui.altScreen.nextPrompt",
  "tui.altScreen.top",
] as const;
const KEY_MODIFIER_ORDER = ["shift", "ctrl", "alt", "super"] as const;
const MATCHABLE_SPECIAL_KEYS = new Set([
  "space",
  "tab",
  "enter",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
]);
const MATCHABLE_SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?");

function normalizedKeyId(key: string): string {
  const parts = key.toLowerCase().split("+");
  const base = parts.at(-1);
  if (!base) return "";
  const configuredModifiers = parts.slice(0, -1);
  if (
    new Set(configuredModifiers).size !== configuredModifiers.length ||
    configuredModifiers.some((modifier) => !KEY_MODIFIER_ORDER.includes(modifier as never))
  )
    return "";
  const normalizedBase = base === "esc" ? "escape" : base === "return" ? "enter" : base;
  const modifiers = KEY_MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
  return [...modifiers, normalizedBase].join("+");
}

function formatEffectiveKeyLabel(key: string): string {
  const parts = key.split("+");
  const base = parts.at(-1);
  if (base === "pageup") parts[parts.length - 1] = "pageUp";
  if (base === "pagedown") parts[parts.length - 1] = "pageDown";
  return formatKeyLabel(parts.join("+"));
}

function canMatchKeyInput(key: string): boolean {
  const parts = key.split("+");
  const base = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1);
  if (base === "escape") return modifiers.length === 0;
  if (base === "clear") {
    return modifiers.length === 0 || (modifiers.length === 1 && (modifiers[0] === "shift" || modifiers[0] === "ctrl"));
  }
  if (/^f(?:[1-9]|1[0-2])$/u.test(base)) return modifiers.length === 0;
  return (
    MATCHABLE_SPECIAL_KEYS.has(base) ||
    (base.length === 1 && (/^[a-z0-9]$/u.test(base) || MATCHABLE_SYMBOL_KEYS.has(base)))
  );
}

function rawCtrlInput(base: string): string | undefined {
  if (base.length !== 1) return undefined;
  const rawBase = base === "-" ? "_" : base;
  if (!"abcdefghijklmnopqrstuvwxyz[\\]_".includes(rawBase)) return undefined;
  return String.fromCharCode(rawBase.charCodeAt(0) & 0x1f);
}

function legacyRawInput(key: string): string | undefined {
  const parts = key.split("+");
  const base = parts.at(-1) ?? "";
  if (parts.length === 2 && parts[0] === "ctrl") return rawCtrlInput(base);
  if (isKittyProtocolActive()) return undefined;
  if (parts.length === 2 && parts[0] === "alt" && base.length === 1) return `\u001b${base}`;
  if (parts.length === 3 && parts[0] === "ctrl" && parts[1] === "alt") {
    const input = rawCtrlInput(base);
    return input ? `\u001b${input}` : undefined;
  }
  return undefined;
}

// Mirror matchesKey(), using parseKey() to canonicalize IDs that share legacy raw input.
function keyInputIdentity(key: string): string {
  const identity = normalizedKeyId(key);
  const input = legacyRawInput(identity);
  return input ? normalizedKeyId(parseKey(input) ?? identity) : identity;
}

export function hasManualSelectionCopyApi(): boolean {
  return (
    typeof TuiAltScreen.prototype.hasActiveSelection === "function" &&
    typeof TuiAltScreen.prototype.copyActiveSelectionToClipboard === "function"
  );
}

export function createBtwFullscreenTui(
  parent: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  copyOnSelect: boolean,
  manualSelectionCopySupported: boolean,
  openUrl: (url: string) => void,
  copyToClipboard: (text: string) => Promise<void>,
): BtwFullscreenTui {
  if (!copyOnSelect && !manualSelectionCopySupported) {
    throw new Error(
      "Manual fullscreen selection copying is unavailable in this Pi version; update Pi or enable automatic selection copying.",
    );
  }
  const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
  const fullscreen = new BtwTuiAltScreen(parent.terminal, parent.getShowHardwareCursor(), undefined, {
    mouse: true,
    wheelScrollLines: "auto",
    copyOnSelect,
    searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
    scrollToEndIndicator: () => {
      const unavailableKeyIdentities = new Set<string>([keyInputIdentity(Key.ctrl("c"))]);
      for (const action of ALT_SCREEN_ACTIONS_BEFORE_BOTTOM) {
        for (const actionKey of keybindings.getKeys(action)) {
          unavailableKeyIdentities.add(keyInputIdentity(String(actionKey)));
        }
      }
      if (!copyOnSelect) {
        for (const copyKey of keybindings.getKeys("app.message.copy")) {
          unavailableKeyIdentities.add(keyInputIdentity(String(copyKey)));
        }
      }
      const key = keybindings
        .getKeys("tui.altScreen.bottom")
        .map((candidate) => keyInputIdentity(String(candidate)))
        .find(
          (identity) =>
            identity &&
            canMatchKeyInput(identity) &&
            !unavailableKeyIdentities.has(identity) &&
            formatEffectiveKeyLabel(identity),
        );
      const label = theme.fg("text", " ↓ Jump to latest message");
      const shortcut = key ? theme.fg("muted", ` · ${formatEffectiveKeyLabel(key)}`) : "";
      return theme.bg("selectedBg", `${label}${shortcut} `);
    },
    searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
    searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
    openUrl,
    copySelection: async (text) => {
      try {
        await copyToClipboard(text);
        return true;
      } catch (error) {
        return sanitizeSingleLine(error instanceof Error ? error.message : String(error)) || "Copy failed";
      }
    },
  });
  if (!copyOnSelect) {
    let isInBracketedPaste = false;
    fullscreen.addInputListenerBeforeViewport((data) => {
      const wasInBracketedPaste = isInBracketedPaste;
      const startsBracketedPaste = data.includes(BRACKETED_PASTE_START);
      if (startsBracketedPaste) isInBracketedPaste = true;
      if (isInBracketedPaste && data.includes(BRACKETED_PASTE_END)) {
        isInBracketedPaste = false;
      }
      if (
        wasInBracketedPaste ||
        startsBracketedPaste ||
        fullscreen.hasFocusedOverlay() ||
        isKeyRelease(data) ||
        !keybindings.matches(data, "app.message.copy")
      ) {
        return undefined;
      }
      if (!fullscreen.hasActiveSelection()) {
        fullscreen.flash("No selection to copy");
        return { consume: true };
      }
      void fullscreen.copyActiveSelectionToClipboard().catch(() => fullscreen.flash("Copy failed"));
      return { consume: true };
    });
  }
  return fullscreen;
}

// Pi does not export its browser opener, so mirror its shell-free launcher for this isolated TUI.
export function openUrlInBrowser(target: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}
