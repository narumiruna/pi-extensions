import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKittyProtocolActive,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  setKittyProtocolActive,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, vi } from "vitest";
import { type ScopePickerOptions, showScopePicker } from "../src/picker.js";

const definitions = {
  ...TUI_KEYBINDINGS,
  "app.session.togglePath": { defaultKeys: "ctrl+p", description: "Toggle path display" },
} as const;
const originalKeys = getKeybindings();
const originalKitty = isKittyProtocolActive();
beforeEach(() => setKeybindings(new KeybindingsManager(definitions)));
afterEach(() => {
  setKeybindings(originalKeys);
  setKittyProtocolActive(originalKitty);
});

export function setup(overrides: Partial<ScopePickerOptions> = {}, bindings: KeybindingsConfig = {}) {
  const keys = new KeybindingsManager(definitions, bindings);
  setKeybindings(keys);
  const roles = new Set<string>();
  const zeroFrames: string[][] = [];
  const tui = createTuiHarness({
    width: 100,
    rows: 32,
    keybindings: keys,
    theme: {
      fg: (role, text) => {
        roles.add(role);
        return text;
      },
      bold: (text) => text,
    },
  });
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      zeroFrames.push(component.render(0));
      return component;
    }, options);
  const ctx = { mode: "tui", hasUI: true, ui: { custom, notify() {} } } as unknown as ExtensionCommandContext;
  const validate = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({ path, canonical: path })));
  const resolvePath = vi.fn(async (raw: string) => ({ path: raw, canonical: raw }));
  const options: ScopePickerOptions = {
    cwd: "/cwd",
    targets: [],
    completionLabel: "Start restriction",
    signal: new AbortController().signal,
    isCurrent: () => true,
    discover: async () => ["/cwd/a file", "/cwd/b", "/cwd/other"],
    resolvePath,
    validate,
    ...overrides,
  };
  return { tui, options, validate, resolvePath, roles, zeroFrames, running: showScopePicker(ctx, options) };
}

export const plain = (lines: readonly string[]) => stripTerminalSequences(lines.join("\n"));
