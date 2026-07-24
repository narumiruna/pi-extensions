import { defineModule, type ModuleDefinition, type ModuleOptionSchema } from "./types.js";
import { workspaceModuleValues } from "./workspace-helpers.js";

function cloudModule<const Name extends string>(definition: {
	name: Name;
	variables: readonly string[];
	format: string;
	symbol: string;
	style: string;
	options: Readonly<Record<string, ModuleOptionSchema>>;
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

export const awsModule = cloudModule({
	name: "aws",
	variables: ["profile", "region"],
	format: "on [$symbol($profile )(\\($region\\) )]($style)",
	symbol: "☁️  ",
	style: "bold yellow",
	options: {
		profile_aliases: { kind: "string-map", default: {} },
		region_aliases: { kind: "string-map", default: {} },
	},
});

export const gcloudModule = cloudModule({
	name: "gcloud",
	variables: ["active", "account", "domain", "project", "region"],
	format: "on [$symbol$project]($style) ",
	symbol: "☁️  ",
	style: "bold blue",
	options: {
		project_aliases: { kind: "string-map", default: {} },
		region_aliases: { kind: "string-map", default: {} },
	},
});

export const azureModule = cloudModule({
	name: "azure",
	variables: ["subscription", "username"],
	format: "on [$symbol$subscription]($style) ",
	symbol: "󰠅 ",
	style: "blue bold",
	options: {
		subscription_aliases: { kind: "string-map", default: {} },
		show_username: { kind: "boolean", default: false },
	},
});

export const openstackModule = cloudModule({
	name: "openstack",
	variables: ["cloud", "project"],
	format: "on [$symbol$cloud( \\($project\\))]($style) ",
	symbol: "☁️  ",
	style: "bold yellow",
	options: {
		cloud_aliases: { kind: "string-map", default: {} },
		project_aliases: { kind: "string-map", default: {} },
	},
});

export const cloudModules = [awsModule, gcloudModule, azureModule, openstackModule] as const;
