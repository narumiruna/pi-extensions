import { defineModule } from "./types.js";
import { workspaceModuleValues } from "./workspace-helpers.js";

export const osModule = defineModule({
	name: "os",
	variables: ["symbol", "type", "name", "version", "edition", "codename"],
	defaults: {
		format: "[$symbol($name )]($style)",
		symbol: "",
		style: "bold white",
		disabled: true,
	},
	options: {
		symbols: {
			kind: "string-map",
			default: { linux: "🐧 ", macos: "🍎 ", windows: " ", wsl: " " },
		},
	},
	values: (context) => workspaceModuleValues("os", context),
});

export const containerModule = defineModule({
	name: "container",
	variables: ["symbol", "name", "type"],
	defaults: {
		format: "[$symbol$name]($style) ",
		symbol: "⬢ ",
		style: "bold red dimmed",
		disabled: false,
	},
	values: (context) => workspaceModuleValues("container", context),
});

export const hostnameModule = defineModule({
	name: "hostname",
	variables: ["symbol", "hostname", "ssh_symbol"],
	defaults: {
		format: "[$ssh_symbol$hostname]($style) in ",
		symbol: "",
		style: "bold dimmed green",
		disabled: false,
	},
	options: {
		ssh_only: { kind: "boolean", default: true },
		trim_at: { kind: "string", default: ".", allowEmpty: false },
		aliases: { kind: "string-map", default: {} },
	},
	values: (context) => workspaceModuleValues("hostname", context),
});

export const usernameModule = defineModule({
	name: "username",
	variables: ["symbol", "user"],
	defaults: {
		format: "[$user]($style) in ",
		symbol: "",
		style: "yellow bold",
		disabled: false,
	},
	options: {
		show_always: { kind: "boolean", default: false },
		aliases: { kind: "string-map", default: {} },
		detect_env_vars: { kind: "string-array", default: [] },
	},
	values: (context) => workspaceModuleValues("username", context),
});

export const executionModules = [
	osModule,
	containerModule,
	hostnameModule,
	usernameModule,
] as const;
