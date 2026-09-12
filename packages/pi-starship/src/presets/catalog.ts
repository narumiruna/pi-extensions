import { BRACKETED_SEGMENTS_PRESET } from "./bracketed-segments.js";
import { CATPPUCCIN_POWERLINE_PRESET } from "./catppuccin-powerline.js";
import { GRUVBOX_RAINBOW_PRESET } from "./gruvbox-rainbow.js";
import { JETPACK_PRESET } from "./jetpack.js";
import { MINIMAL_PRESET } from "./minimal.js";
import { NERD_FONT_SYMBOLS_PRESET } from "./nerd-font-symbols.js";
import { NO_EMPTY_ICONS_PRESET } from "./no-empty-icons.js";
import { NO_NERD_FONT_PRESET } from "./no-nerd-font.js";
import { NO_RUNTIME_VERSIONS_PRESET } from "./no-runtime-versions.js";
import { PASTEL_POWERLINE_PRESET } from "./pastel-powerline.js";
import { PLAIN_TEXT_SYMBOLS_PRESET } from "./plain-text-symbols.js";
import { PURE_PRESET } from "./pure-preset.js";
import { TOKYO_NIGHT_PRESET } from "./tokyo-night.js";

export interface StarshipPreset {
  id:
    | "minimal"
    | "bracketed-segments"
    | "catppuccin-powerline"
    | "gruvbox-rainbow"
    | "jetpack"
    | "nerd-font-symbols"
    | "no-empty-icons"
    | "no-nerd-font"
    | "no-runtime-versions"
    | "pastel-powerline"
    | "plain-text-symbols"
    | "pure-preset"
    | "tokyo-night";
  label: string;
  description: string;
  requiresNerdFont: boolean;
  rawDocument: string;
}

export const STARSHIP_PRESETS = [
  {
    id: "minimal",
    label: "Minimal",
    description: "Compact Pi essentials · font-safe",
    requiresNerdFont: false,
    rawDocument: MINIMAL_PRESET,
  },
  {
    id: "bracketed-segments",
    label: "Bracketed Segments",
    description: "Balanced Pi and Git details in brackets · font-safe",
    requiresNerdFont: false,
    rawDocument: BRACKETED_SEGMENTS_PRESET,
  },
  {
    id: "catppuccin-powerline",
    label: "Catppuccin Powerline",
    description: "Mocha connected color blocks · requires Nerd Font",
    requiresNerdFont: true,
    rawDocument: CATPPUCCIN_POWERLINE_PRESET,
  },
  {
    id: "gruvbox-rainbow",
    label: "Gruvbox Rainbow",
    description: "Warm Gruvbox connected segments · requires Nerd Font",
    requiresNerdFont: true,
    rawDocument: GRUVBOX_RAINBOW_PRESET,
  },
  {
    id: "jetpack",
    label: "Jetpack",
    description: "Airy geometric left/right layout · font-safe",
    requiresNerdFont: false,
    rawDocument: JETPACK_PRESET,
  },
  {
    id: "nerd-font-symbols",
    label: "Nerd Font Symbols",
    description: "Balanced default layout with icon-rich symbols · requires Nerd Font",
    requiresNerdFont: true,
    rawDocument: NERD_FONT_SYMBOLS_PRESET,
  },
  {
    id: "no-empty-icons",
    label: "No Empty Icons",
    description: "Conditional labels never appear without values · font-safe",
    requiresNerdFont: false,
    rawDocument: NO_EMPTY_ICONS_PRESET,
  },
  {
    id: "no-nerd-font",
    label: "No Nerd Font",
    description: "Portable Unicode symbols without private-use glyphs · font-safe",
    requiresNerdFont: false,
    rawDocument: NO_NERD_FONT_PRESET,
  },
  {
    id: "no-runtime-versions",
    label: "No Runtime Versions",
    description: "Presence indicators without model or thinking details · font-safe",
    requiresNerdFont: false,
    rawDocument: NO_RUNTIME_VERSIONS_PRESET,
  },
  {
    id: "pastel-powerline",
    label: "Pastel Powerline",
    description: "Pastel connected color blocks · requires Nerd Font",
    requiresNerdFont: true,
    rawDocument: PASTEL_POWERLINE_PRESET,
  },
  {
    id: "plain-text-symbols",
    label: "Plain Text Symbols",
    description: "Plain words replace pictograms · font-safe",
    requiresNerdFont: false,
    rawDocument: PLAIN_TEXT_SYMBOLS_PRESET,
  },
  {
    id: "pure-preset",
    label: "Pure Preset",
    description: "Clean two-line workspace and session context · font-safe",
    requiresNerdFont: false,
    rawDocument: PURE_PRESET,
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    description: "Cool connected color blocks · requires Nerd Font",
    requiresNerdFont: true,
    rawDocument: TOKYO_NIGHT_PRESET,
  },
] as const satisfies readonly StarshipPreset[];

export function getStarshipPreset(id: StarshipPreset["id"]): StarshipPreset {
  const preset = STARSHIP_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown pi-starship preset: ${id}`);
  return preset;
}

export function presetForDocument(rawDocument: string | undefined): StarshipPreset | undefined {
  return STARSHIP_PRESETS.find((preset) => preset.rawDocument === rawDocument);
}
