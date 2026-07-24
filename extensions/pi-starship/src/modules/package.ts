import { defineModule } from "./types.js";
import { workspaceModuleValues } from "./workspace-helpers.js";

export const packageModule = defineModule({
	name: "package",
	variables: ["symbol", "version", "source"],
	defaults: {
		format: "via [$symbol$version]($style) ",
		symbol: "📦 ",
		style: "bold 208",
		disabled: false,
	},
	options: {
		version_format: { kind: "string", default: "v$raw" },
	},
	values: (context) => workspaceModuleValues("package", context),
});
