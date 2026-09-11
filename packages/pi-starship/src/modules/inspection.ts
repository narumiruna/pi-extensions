import { stripVTControlCharacters } from "node:util";
import type { StarshipConfig } from "../config.js";
import { formatVariables } from "../format/formatter.js";
import { MODULE_DEFINITIONS, type ModuleName } from "./catalog.js";
import { reachableModuleRequirements, renderStatusline } from "./render.js";
import type { StarshipRuntimeSnapshot } from "./types.js";

export type ModuleInspectionState = "Showing" | "Empty" | "Disabled" | "Not in format" | "Unavailable";

export interface ModuleInspection {
  name: ModuleName;
  description: string;
  state: ModuleInspectionState;
  preview: string;
  variables: readonly string[];
  styleFields: readonly string[];
  displayRules: readonly string[];
  rootReferenced: boolean;
  reachable: boolean;
  reason: string;
}

export interface StatuslineInspection {
  modules: readonly ModuleInspection[];
  showing: readonly ModuleInspection[];
}

export function inspectStatuslineModules(
  config: StarshipConfig,
  runtime: StarshipRuntimeSnapshot,
  width = 80,
): StatuslineInspection {
  const rendered = renderStatusline(config, runtime, width);
  const requirements = reachableModuleRequirements(config);
  const rootVariables = formatVariables(config.formatAst);
  const includeAll = rootVariables.has("all");
  const modules = MODULE_DEFINITIONS.map((definition): ModuleInspection => {
    const module = config.modules[definition.name];
    const reachable = requirements.has(definition.name);
    const preview = plainPreview(rendered.modules[definition.name].map((chunk) => chunk.text).join(""));
    const state = module.disabled
      ? "Disabled"
      : !reachable
        ? "Not in format"
        : preview.length > 0
          ? "Showing"
          : "Empty";
    return moduleInspection(
      config,
      definition,
      state,
      preview,
      includeAll || rootVariables.has(definition.name),
      reachable,
    );
  });
  return {
    modules,
    showing: modules.filter((module) => module.state === "Showing"),
  };
}

export function inspectUnavailableModules(config: StarshipConfig): StatuslineInspection {
  const requirements = reachableModuleRequirements(config);
  const rootVariables = formatVariables(config.formatAst);
  const includeAll = rootVariables.has("all");
  return {
    modules: MODULE_DEFINITIONS.map((definition) => {
      const module = config.modules[definition.name];
      const reachable = requirements.has(definition.name);
      const state = module.disabled ? "Disabled" : reachable ? "Unavailable" : "Not in format";
      return moduleInspection(
        config,
        definition,
        state,
        "",
        includeAll || rootVariables.has(definition.name),
        reachable,
      );
    }),
    showing: [],
  };
}

function moduleInspection(
  config: StarshipConfig,
  definition: (typeof MODULE_DEFINITIONS)[number],
  state: ModuleInspectionState,
  preview: string,
  rootReferenced: boolean,
  reachable: boolean,
): ModuleInspection {
  const module = config.modules[definition.name];
  return {
    name: definition.name,
    description: definition.description,
    state,
    preview,
    variables: [...definition.variables],
    styleFields: ["style", ...Object.keys(module.styles)],
    displayRules: module.display.map(
      (rule) => `${rule.threshold}: ${rule.hidden ? "hidden" : rule.style || "unstyled"}`,
    ),
    rootReferenced,
    reachable,
    reason: inspectionReason(state),
  };
}

function inspectionReason(state: ModuleInspectionState): string {
  switch (state) {
    case "Showing":
      return "Rendered in the current footer.";
    case "Empty":
      return "Referenced by the root format, but the current snapshot produced no output.";
    case "Disabled":
      return "Disabled by this module's configuration.";
    case "Not in format":
      return "Not referenced by the root format or $all.";
    case "Unavailable":
      return "Current footer inspection is unavailable; no collector failure was inferred.";
  }
}

function plainPreview(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\n") return character;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }).join("");
}
