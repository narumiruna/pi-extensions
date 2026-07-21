import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorktreeCommand } from "./command.js";

export default function worktreeExtension(pi: ExtensionAPI): void {
	registerWorktreeCommand(pi);
}
