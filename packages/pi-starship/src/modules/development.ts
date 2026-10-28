import { truncatePathComponents } from "./truncation.js";
import { defineModule, type ModuleDefinition, type ModuleOptionSchema } from "./types.js";
import { workspaceModuleValues } from "./workspace-helpers.js";

function developmentModule<const Name extends string>(definition: {
  name: Name;
  variables: readonly string[];
  format: string;
  symbol: string;
  style: string;
  options?: Readonly<Record<string, ModuleOptionSchema>>;
}): ModuleDefinition<Name> {
  return defineModule({
    name: definition.name,
    variables: ["symbol", ...definition.variables],
    defaults: {
      format: definition.format,
      symbol: definition.symbol,
      style: definition.style,
      disabled: false,
    },
    options: definition.options,
    values: (context) => workspaceModuleValues(definition.name, context),
  });
}

const directDetection = {
  detect_files: { kind: "string-array", default: [] },
  detect_extensions: { kind: "string-array", default: [] },
  detect_folders: { kind: "string-array", default: [] },
} as const;

export const miseModule = developmentModule({
  name: "mise",
  variables: ["health"],
  format: "via [$symbol$health]($style) ",
  symbol: "mise ",
  style: "bold purple",
  options: {
    ...directDetection,
    healthy_symbol: { kind: "string", default: "healthy" },
    unhealthy_symbol: { kind: "string", default: "issues" },
  },
});

export const direnvModule = developmentModule({
  name: "direnv",
  variables: ["rc_path", "allowed", "loaded"],
  format: "[$symbol$loaded]($style) ",
  symbol: "direnv ",
  style: "bold bright-yellow",
  options: {
    ...directDetection,
    detect_env_vars: { kind: "string-array", default: [], allowNegative: true },
    allowed_msg: { kind: "string", default: "allowed" },
    not_allowed_msg: { kind: "string", default: "not allowed" },
    denied_msg: { kind: "string", default: "denied" },
    loaded_msg: { kind: "string", default: "loaded" },
    unloaded_msg: { kind: "string", default: "not loaded" },
  },
});

export const condaModule = defineModule({
  name: "conda",
  variables: ["symbol", "environment"],
  defaults: {
    format: "via [$symbol$environment]($style) ",
    symbol: "🅒 ",
    style: "green bold",
    disabled: false,
  },
  options: {
    ignore_base: { kind: "boolean", default: true },
    detect_env_vars: { kind: "string-array", default: [], allowNegative: true },
    truncation_length: { kind: "integer", default: 1, minimum: 0, maximum: 1_000_000 },
  },
  values: (context) => {
    const values = workspaceModuleValues("conda", context);
    const environment = values?.environment;
    if (!environment) return undefined;
    const length = typeof context.options.truncation_length === "number" ? context.options.truncation_length : 1;
    return {
      environment: truncatePathComponents(environment, length).value,
    };
  },
});

export const pixiModule = developmentModule({
  name: "pixi",
  variables: ["version", "environment", "project_name"],
  format: "via [$symbol$environment]($style) ",
  symbol: "🧚 ",
  style: "yellow bold",
  options: {
    ...directDetection,
    version_format: { kind: "string", default: "v$raw" },
    show_default_environment: { kind: "boolean", default: false },
  },
});

export const nixShellModule = developmentModule({
  name: "nix_shell",
  variables: ["state", "name", "level"],
  format: "via [$symbol$state( \\($name\\))]($style) ",
  symbol: " ",
  style: "bold blue",
  // No unknown_msg: unknown shells require unsupported heuristic discovery from PATH.
  options: {
    pure_msg: { kind: "string", default: "pure" },
    impure_msg: { kind: "string", default: "impure" },
  },
});

export const guixShellModule = developmentModule({
  name: "guix_shell",
  variables: ["state"],
  format: "via [$symbol]($style) ",
  symbol: "🐃 ",
  style: "yellow bold",
});

export const developmentModules = [
  miseModule,
  direnvModule,
  condaModule,
  pixiModule,
  nixShellModule,
  guixShellModule,
] as const;
