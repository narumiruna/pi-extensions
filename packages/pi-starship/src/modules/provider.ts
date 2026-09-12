import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { defineModule } from "./types.js";

const PROVIDER_ALIASES_KEY = "provider_aliases";

export const providerModule = defineModule({
  name: "provider",
  variables: ["symbol", "provider"],
  defaults: {
    format: "[$symbol $provider ]($style)",
    symbol: "🔌",
    style: "bold blue",
    disabled: false,
  },
  options: {
    [PROVIDER_ALIASES_KEY]: { kind: "string-map", default: {} },
  },
  values: ({ runtime, options }) => {
    if (!runtime.model) return undefined;
    const aliases = options[PROVIDER_ALIASES_KEY];
    const aliasMap =
      aliases && typeof aliases === "object" && !Array.isArray(aliases)
        ? (aliases as Readonly<Record<string, string>>)
        : undefined;
    const alias =
      aliasMap && Object.hasOwn(aliasMap, runtime.model.provider) ? aliasMap[runtime.model.provider] : undefined;
    return { provider: sanitizeTerminalText(alias ?? runtime.model.provider) };
  },
});
