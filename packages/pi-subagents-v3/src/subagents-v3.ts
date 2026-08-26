import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTools, type SubagentToolsDependencies } from "./tools.js";

export type SubagentsV3Dependencies = SubagentToolsDependencies;

export default function subagentsV3(
	pi: ExtensionAPI,
	dependencies: SubagentsV3Dependencies = {},
): void {
	const tools = registerSubagentTools(pi, dependencies);

	pi.on("session_shutdown", async () => {
		await tools.shutdown();
	});
}
