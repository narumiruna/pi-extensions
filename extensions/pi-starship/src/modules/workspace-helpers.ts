import type { ModuleValueContext } from "./types.js";

export function workspaceModuleValues(
	name: string,
	context: ModuleValueContext,
): Record<string, string> | undefined {
	const values = context.runtime.workspace?.modules[name];
	if (!values) return undefined;
	return { ...values };
}
