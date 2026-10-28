import { configurationPresentation } from "./command-configuration.js";
import type { LoadedStarshipConfig } from "./config.js";
import { serializeEffectiveConfig } from "./effective-config.js";
import type { StatuslineInspection } from "./modules/inspection.js";

/** Serialize once at chat opening; neither draft previews nor later runtime changes update these documents. */
export function settingsSnapshots(
  loaded: LoadedStarshipConfig,
  settingsPath: string,
  inspection: StatuslineInspection | undefined,
) {
  const presentation = configurationPresentation(loaded);
  return {
    "active-document.toml": loaded.rawDocument,
    "active-effective.toml": serializeEffectiveConfig(loaded.config),
    "active-state.json": JSON.stringify(
      {
        snapshot: "Active configuration at chat opening; not the draft or a continuously current view",
        state: presentation.state,
        source: presentation.source,
        path: settingsPath,
        health: presentation.health,
        loadedDocumentAvailable: loaded.rawDocument !== undefined,
        diagnostics: loaded.diagnostics,
      },
      null,
      2,
    ),
    "active-modules.json": JSON.stringify(
      {
        snapshot: "Module inspection at chat opening; draft previews do not change this snapshot",
        available: inspection !== undefined,
        ...(inspection
          ? { inspection }
          : { reason: "Runtime inspection unavailable: the footer is not ready. Do not infer live module states." }),
      },
      null,
      2,
    ),
  };
}
