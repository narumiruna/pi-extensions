import { defineModule } from "./types.js";
import { workspaceModuleValues } from "./workspace-helpers.js";

const directDetection = {
	detect_files: { kind: "string-array", default: [] },
	detect_extensions: { kind: "string-array", default: [] },
	detect_folders: { kind: "string-array", default: [] },
} as const;

export const dockerContextModule = defineModule({
	name: "docker_context",
	variables: ["symbol", "context"],
	defaults: {
		format: "via [$symbol$context]($style) ",
		symbol: " ",
		style: "blue bold",
		disabled: false,
	},
	options: {
		...directDetection,
		only_with_files: { kind: "boolean", default: false },
	},
	values: (context) => workspaceModuleValues("docker_context", context),
});

export const kubernetesModule = defineModule({
	name: "kubernetes",
	variables: ["symbol", "context", "namespace", "cluster", "user"],
	defaults: {
		format: "on [$symbol$context( \\($namespace\\))]($style) ",
		symbol: "☸ ",
		style: "cyan bold",
		disabled: false,
	},
	options: {
		context_aliases: { kind: "string-map", default: {} },
		namespace_aliases: { kind: "string-map", default: {} },
		cluster_aliases: { kind: "string-map", default: {} },
		user_aliases: { kind: "string-map", default: {} },
		max_config_files: { kind: "integer", default: 8, minimum: 1, maximum: 32 },
	},
	values: (context) => workspaceModuleValues("kubernetes", context),
});

export const terraformModule = defineModule({
	name: "terraform",
	variables: ["symbol", "workspace", "version"],
	defaults: {
		format: "via [$symbol$workspace]($style) ",
		symbol: "💠 ",
		style: "bold 105",
		disabled: false,
	},
	options: {
		...directDetection,
		version_format: { kind: "string", default: "v$raw" },
	},
	values: (context) => workspaceModuleValues("terraform", context),
});

export const deploymentModules = [dockerContextModule, kubernetesModule, terraformModule] as const;
