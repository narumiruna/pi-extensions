import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorktreeCommand } from "./command.js";
import {
	createWorktreeSettingsRuntime,
	settingsFilePath,
	type WorktreeSettingsRuntime,
} from "./settings.js";

interface WorktreeExtensionOptions {
	settings?: WorktreeSettingsRuntime;
}

export default function worktreeExtension(
	pi: ExtensionAPI,
	options: WorktreeExtensionOptions = {},
): void {
	const settings = options.settings ?? createWorktreeSettingsRuntime({ path: settingsFilePath });
	registerWorktreeCommand(pi, settings);

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await settings.reload();
		if (!loaded.warning || !ctx.hasUI) return;
		try {
			ctx.ui.notify(loaded.warning, "warning");
		} catch {
			// A replacement session may invalidate its predecessor context during async startup.
		}
	});
}
