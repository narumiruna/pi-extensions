import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMAND_NAME = "e2e-control";
const SENTINEL_PATH_ENV = "PI_E2E_SHUTDOWN_SENTINEL";
const CREDENTIAL_ENV_NAMES = [
	"ANTHROPIC_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"E2E_SECRET_API_KEY",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"NPM_TOKEN",
] as const;

export default function controlExtension(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Inspect or stop an isolated extension E2E process",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "inspect") {
				ctx.ui.notify(
					`PI_E2E_CONTROL ${JSON.stringify({
						agentDir: process.env.PI_CODING_AGENT_DIR,
						commands: pi.getCommands().map((command) => command.name),
						credentialLeaks: CREDENTIAL_ENV_NAMES.filter((name) => process.env[name] !== undefined),
						home: process.env.HOME ?? process.env.USERPROFILE,
						safeMarker: process.env.PI_E2E_SAFE_MARKER,
					})}`,
					"info",
				);
				return;
			}
			if (action === "shutdown") {
				ctx.ui.notify("PI_E2E_CONTROL shutting down", "info");
				ctx.shutdown();
				return;
			}
			ctx.ui.notify(`Usage: /${COMMAND_NAME} inspect|shutdown`, "warning");
		},
	});

	pi.on("session_shutdown", async (event) => {
		const sentinelPath = process.env[SENTINEL_PATH_ENV];
		if (!sentinelPath) return;
		await writeFile(
			sentinelPath,
			`${JSON.stringify({ reason: event.reason, timestamp: Date.now() })}\n`,
			"utf8",
		);
	});
}
