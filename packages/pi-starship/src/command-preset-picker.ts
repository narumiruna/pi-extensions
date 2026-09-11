import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runLiveChoice } from "@narumitw/pi-tui-kit";
import type { StarshipPreset } from "./presets/catalog.js";

export type PresetPickerResult =
  | { kind: "apply"; presetId: StarshipPreset["id"] }
  | { kind: "customize"; presetId: StarshipPreset["id"] }
  | { kind: "back" }
  | { kind: "close" };

export interface PresetPickerOptions {
  presets: readonly StarshipPreset[];
  activePresetId?: StarshipPreset["id"];
  initialPresetId?: StarshipPreset["id"];
  signal: AbortSignal;
  isCurrent(): boolean;
  preview(preset: StarshipPreset): void;
}

export async function showPresetPicker(
  ctx: ExtensionCommandContext,
  options: PresetPickerOptions,
): Promise<PresetPickerResult> {
  const current =
    options.presets.find((preset) => preset.id === options.activePresetId)?.label ?? "Custom configuration";
  const result = await runLiveChoice(ctx, {
    title: `Presets · current: ${current}`,
    items: options.presets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description:
        preset.id === options.activePresetId ? `Currently applied · ${preset.description}` : preset.description,
      details: [`Selected: ${preset.label} · ${preset.requiresNerdFont ? "requires Nerd Font" : "font-safe"}`],
      confirmationDisabled: preset.id === options.activePresetId,
      confirmationDisabledReason: "Already applied; press e to customize",
    })),
    currentItemId: options.activePresetId,
    initialItemId: options.initialPresetId ?? options.activePresetId,
    viewportSize: Math.min(options.presets.length, 10),
    hint: "back",
    navigationLabel: "live preview",
    confirmLabel: "apply",
    shortcuts: [{ id: "customize", keys: ["e", "shift+e"], label: "customize" }],
    onSelectionChange: ({ item }) => {
      const preset = options.presets.find((candidate) => candidate.id === item.id);
      if (preset) options.preview(preset);
    },
    signal: options.signal,
    isCurrent: options.isCurrent,
  });
  if (result.kind === "selected") return { kind: "apply", presetId: result.itemId };
  if (result.kind === "shortcut") {
    return { kind: "customize", presetId: result.itemId };
  }
  if (result.kind === "closed" && result.reason === "back") return { kind: "back" };
  return { kind: "close" };
}
