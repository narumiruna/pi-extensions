import { defineModule, type ModuleDefinition } from "./types.js";
import { workspaceModuleValues } from "./workspace-helpers.js";

const detectionOptions = {
	version_format: { kind: "string", default: "v$raw" },
	detect_files: { kind: "string-array", default: [], allowNegative: true },
	detect_extensions: { kind: "string-array", default: [], allowNegative: true },
	detect_folders: { kind: "string-array", default: [], allowNegative: true },
} as const;

function languageModule<const Name extends string>(definition: {
	name: Name;
	variables: readonly string[];
	format: string;
	symbol: string;
	style: string;
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
		options: detectionOptions,
		values: (context) => workspaceModuleValues(definition.name, context),
	});
}

export const nodejsModule = languageModule({
	name: "nodejs",
	variables: ["version", "engines_version"],
	format: "via [$symbol($version )]($style)",
	symbol: " ",
	style: "bold green",
});

export const pythonModule = languageModule({
	name: "python",
	variables: ["version", "virtualenv", "pyenv_prefix"],
	format: "via [$symbol$pyenv_prefix($version )(\\($virtualenv\\) )]($style)",
	symbol: " ",
	style: "yellow bold",
});

export const rustModule = languageModule({
	name: "rust",
	variables: ["version", "numver", "toolchain"],
	format: "via [$symbol($version )]($style)",
	symbol: " ",
	style: "bold red",
});

export const golangModule = languageModule({
	name: "golang",
	variables: ["version", "mod_version"],
	format: "via [$symbol($version )]($style)",
	symbol: " ",
	style: "bold cyan",
});

export const bunModule = languageModule({
	name: "bun",
	variables: ["version"],
	format: "via [$symbol($version )]($style)",
	symbol: "🍞 ",
	style: "bold red",
});

export const denoModule = languageModule({
	name: "deno",
	variables: ["version"],
	format: "via [$symbol($version )]($style)",
	symbol: "🦕 ",
	style: "green bold",
});

export const languageModules = [
	nodejsModule,
	pythonModule,
	rustModule,
	golangModule,
	bunModule,
	denoModule,
] as const;
