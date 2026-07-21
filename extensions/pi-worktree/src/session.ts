import { existsSync, writeFileSync } from "node:fs";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalControls } from "./git.js";

export type WorktreeSwitchResult = "switched" | "cancelled" | "failed";

export async function switchToWorktree(
	ctx: ExtensionCommandContext,
	targetPath: string,
): Promise<WorktreeSwitchResult> {
	let sessionPath: string | undefined;
	try {
		sessionPath = createTargetSession(ctx, targetPath);
		const result = await ctx.switchSession(sessionPath, {
			withSession: async (replacementCtx) => {
				replacementCtx.ui.notify(
					stripTerminalControls(`Switched Pi workspace to ${targetPath}.`),
					"info",
				);
			},
		});
		if (result.cancelled) {
			ctx.ui.notify(
				stripTerminalControls(
					`Workspace switch was cancelled. The prepared target session was retained at ${sessionPath}.`,
				),
				"info",
			);
			return "cancelled";
		}
		return "switched";
	} catch (error) {
		const retained = sessionPath ? " The prepared target session was retained." : "";
		const message = stripTerminalControls(
			`Could not switch Pi workspace to ${targetPath}.${retained} The worktree was retained. Retry from /worktree. ${formatError(error)}`,
		);
		try {
			ctx.ui.notify(message, "error");
		} catch {
			console.error(message);
		}
		return "failed";
	}
}

export function createTargetSession(ctx: ExtensionCommandContext, targetPath: string): string {
	const sourceFile = ctx.sessionManager.getSessionFile();
	if (sourceFile && existsSync(sourceFile)) {
		const persisted = SessionManager.open(sourceFile);
		const activeLeaf = ctx.sessionManager.getLeafId();
		if (persisted.getLeafId() === activeLeaf) {
			const forked = SessionManager.forkFrom(sourceFile, targetPath);
			const targetFile = forked.getSessionFile();
			if (!targetFile || !existsSync(targetFile)) {
				throw new Error("Pi did not create the target worktree session file.");
			}
			return targetFile;
		}
		if (activeLeaf !== null && !persisted.getEntry(activeLeaf)) {
			throw new Error("The active Pi session branch is not present in the persisted source file.");
		}
		return writeTargetSession(targetPath, ctx.sessionManager.getBranch(), sourceFile, activeLeaf);
	}

	if (ctx.sessionManager.getEntries().length > 0) {
		throw new Error(
			"The current Pi session is not persisted but contains conversation entries; switching was refused to prevent context loss.",
		);
	}

	return writeTargetSession(targetPath, [], undefined, null);
}

function writeTargetSession(
	targetPath: string,
	entries: readonly SessionEntry[],
	parentSession: string | undefined,
	expectedLeaf: string | null,
): string {
	const target = SessionManager.create(targetPath, undefined, { parentSession });
	const targetFile = target.getSessionFile();
	const header = target.getHeader();
	if (!targetFile || !header) throw new Error("Pi could not prepare a target session.");
	const document = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(targetFile, `${document}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	const verified = SessionManager.open(targetFile);
	if (verified.getCwd() !== targetPath || verified.getLeafId() !== expectedLeaf) {
		throw new Error("Pi could not verify the target session cwd and active branch.");
	}
	return targetFile;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
