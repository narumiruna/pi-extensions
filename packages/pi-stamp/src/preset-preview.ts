import type { StampSettings } from "./format.js";
import { METADATA_PRESETS, type StampMetadataPreset } from "./metadata-settings.js";

export interface StampPresetPreview {
  set(preset: StampMetadataPreset): void;
  dispose(): void;
}

interface ActivePreview {
  preset?: StampMetadataPreset;
  dispose(): void;
}

/** Overlay renderer settings only; capture and persistence keep their canonical settings. */
export function createStampDisplaySettings(getSettings: () => Readonly<StampSettings>) {
  let active: ActivePreview | undefined;
  return {
    get(): Readonly<StampSettings> {
      const settings = getSettings();
      return active?.preset === undefined ? settings : { ...settings, ...METADATA_PRESETS[active.preset] };
    },
    begin(signal: AbortSignal): StampPresetPreview {
      // A cancelled caller cannot acquire ownership or clear a newer live preview.
      if (signal.aborted) return { set() {}, dispose() {} };
      active?.dispose();
      const preview: ActivePreview = {
        dispose() {
          signal.removeEventListener("abort", preview.dispose);
          if (active === preview) active = undefined;
        },
      };
      active = preview;
      signal.addEventListener("abort", preview.dispose, { once: true });
      return {
        set(preset) {
          if (active === preview && !signal.aborted) preview.preset = preset;
        },
        dispose: preview.dispose,
      };
    },
    clear() {
      active?.dispose();
    },
  };
}
