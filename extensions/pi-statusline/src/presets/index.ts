import type { PalettePreset } from "../types.js";
import { CANDY_PRESET } from "./candy.js";
import { CUSTOM_PRESET } from "./custom.js";
import { FOREST_PRESET } from "./forest.js";
import { MONO_PRESET } from "./mono.js";
import { NEON_PRESET } from "./neon.js";
import { OCEAN_PRESET } from "./ocean.js";
import { SUNSET_PRESET } from "./sunset.js";
import { TOKYO_NIGHT_PRESET } from "./tokyo-night.js";
import type { PowerlinePreset } from "./types.js";

const PRESETS = {
	"tokyo-night": TOKYO_NIGHT_PRESET,
	ocean: OCEAN_PRESET,
	sunset: SUNSET_PRESET,
	forest: FOREST_PRESET,
	candy: CANDY_PRESET,
	neon: NEON_PRESET,
	mono: MONO_PRESET,
	custom: CUSTOM_PRESET,
} satisfies Record<PalettePreset, PowerlinePreset>;

export function resolvePreset(preset: PalettePreset): PowerlinePreset {
	return PRESETS[preset];
}
