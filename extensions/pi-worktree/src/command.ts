import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	addWorktree,
	administrativeHistoryOids,
	administrativePruneCandidates,
	currentWorktreePath,
	defaultWorktreePath,
	durableRefExists,
	durableRefsContaining,
	formatWorktree,
	listWorktrees,
	localBranchExists,
	pathEntryExists,
	pathIdentity,
	pathsEqual,
	prunePreview,
	pruneWorktrees,
	removeWorktree,
	resolveCommit,
	sameWorktreeIdentity,
	stripTerminalControls,
	symbolicBranch,
	validateBranch,
	type WorktreeRecord,
	worktreeAdministrativeDirectory,
	worktreeForBranch,
	worktreeInventory,
} from "./git.js";
import { switchToWorktree } from "./session.js";

const ACTION_LIST = "List worktrees";
const ACTION_ADD = "Add worktree";
const ACTION_SWITCH = "Switch worktree";
const ACTION_REMOVE = "Remove worktree";
const ACTION_PRUNE = "Prune stale metadata";
const ACTIONS = [ACTION_LIST, ACTION_ADD, ACTION_SWITCH, ACTION_REMOVE, ACTION_PRUNE];

export function registerWorktreeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("worktree", {
		description: "Interactively list, add, switch, remove, or prune Git worktrees",
		handler: async (args, ctx) => {
			if (args.trim()) {
				safeNotify(
					ctx,
					"/worktree does not accept arguments; run it without arguments to open the menu.",
					"warning",
				);
				return;
			}
			if (!ctx.hasUI) {
				safeNotify(ctx, "/worktree requires an interactive Pi UI.", "error");
				return;
			}

			try {
				await ctx.waitForIdle();
				const records = await listWorktrees(pi, ctx.cwd, ctx.signal);
				const currentPath = await currentWorktreePath(pi, ctx.cwd, ctx.signal);
				const action = await ctx.ui.select(
					stripTerminalControls(`Git worktrees (${records.length}) — current: ${currentPath}`),
					ACTIONS,
				);
				switch (action) {
					case ACTION_LIST:
						showList(ctx, records, currentPath);
						return;
					case ACTION_ADD:
						await addFlow(pi, ctx, records);
						return;
					case ACTION_SWITCH:
						await switchFlow(pi, ctx, records, currentPath);
						return;
					case ACTION_REMOVE:
						await removeFlow(pi, ctx, records, currentPath);
						return;
					case ACTION_PRUNE:
						await pruneFlow(pi, ctx, records);
						return;
				}
			} catch (error) {
				safeNotify(ctx, formatError(error), "error");
			}
		},
	});
}

function showList(
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
	currentPath: string,
): void {
	ctx.ui.notify(records.map((record) => formatWorktree(record, currentPath)).join("\n"), "info");
}

async function addFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
): Promise<void> {
	const main = records[0];
	if (!main) throw new Error("Git returned no registered worktrees.");
	if (main.bare) {
		throw new Error("The main worktree is bare; pi-worktree cannot derive a safe default path.");
	}
	if (!existsSync(main.path)) {
		throw new Error(
			`The registered main worktree path is stale: ${main.path}. Repair it with Git first.`,
		);
	}

	const requestedBranch = await ctx.ui.input("Branch for the new worktree", "feat/my-change");
	if (requestedBranch === undefined) return;
	const branchInput = requestedBranch.trim();
	if (!branchInput) throw new Error("Branch name is required.");
	const branch = await validateBranch(pi, ctx.cwd, branchInput, ctx.signal);
	const branchExists = await localBranchExists(pi, ctx.cwd, branch, ctx.signal);
	const occupied = worktreeForBranch(records, branch);
	if (occupied) {
		throw new Error(`Branch ${branch} is already checked out at ${occupied.path}.`);
	}

	let startOid: string | undefined;
	let startLabel: string | undefined;
	if (!branchExists) {
		const defaultStart = await symbolicBranch(pi, ctx.cwd, ctx.signal);
		const requestedStart = await ctx.ui.input(
			defaultStart
				? `Start point for ${branch} (blank uses ${defaultStart})`
				: `Start point for ${branch} (required because HEAD is detached)`,
			defaultStart ?? "commit-ish",
		);
		if (requestedStart === undefined) return;
		startLabel = requestedStart.trim() || defaultStart;
		if (!startLabel) throw new Error("An explicit start point is required from detached HEAD.");
		startOid = await resolveCommit(pi, ctx.cwd, startLabel, ctx.signal);
	}

	const suggestedPath = defaultWorktreePath(main.path, branch);
	const requestedPath = await ctx.ui.input(
		stripTerminalControls(`Worktree path (blank uses ${suggestedPath})`),
		stripTerminalControls(suggestedPath),
	);
	if (requestedPath === undefined) return;
	const targetPath = pathIdentity(
		requestedPath.trim() ? resolve(ctx.cwd, requestedPath.trim()) : suggestedPath,
	);
	if (pathEntryExists(targetPath)) {
		throw new Error(`The target path already exists: ${targetPath}.`);
	}
	const pathCollision = records.find((record) => pathsEqual(record.path, targetPath));
	if (pathCollision) {
		throw new Error(`The target path is already registered as a worktree: ${pathCollision.path}.`);
	}

	const summary = branchExists
		? `Attach existing branch ${branch} at ${targetPath}?`
		: `Create branch ${branch} from ${startLabel} at ${targetPath}?`;
	if (!(await ctx.ui.confirm("Create Git worktree", stripTerminalControls(summary)))) return;

	await addWorktree(pi, ctx.cwd, { path: targetPath, branch, startOid }, ctx.signal);
	let created: WorktreeRecord;
	try {
		const updated = await listWorktrees(pi, ctx.cwd, ctx.signal);
		const verified = updated.find((record) => pathsEqual(record.path, targetPath));
		if (!verified || verified.branch !== branch) {
			throw new Error("the expected path and branch were not present in Git porcelain output");
		}
		created = verified;
	} catch (error) {
		throw new Error(
			`Git add completed, so the worktree was retained at ${targetPath}, but verification failed: ${formatError(error)}. Inspect git worktree list before retrying.`,
		);
	}
	safeNotify(ctx, `Created worktree ${targetPath} on branch ${branch}.`, "info");

	if (
		await ctx.ui.confirm(
			"Switch Pi workspace?",
			stripTerminalControls(`Continue this conversation in ${targetPath}?`),
		)
	) {
		const latest = await revalidateWorktreeIdentity(pi, ctx, created);
		if (latest.prunableReason !== undefined || !existsSync(latest.path)) {
			throw new Error("The newly created worktree became unavailable; select it again.");
		}
		await switchToWorktree(ctx, latest.path);
	}
}

async function switchFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
	currentPath: string,
): Promise<void> {
	const candidates = records.filter(
		(record) =>
			!record.bare &&
			record.prunableReason === undefined &&
			existsSync(record.path) &&
			!pathsEqual(record.path, currentPath),
	);
	const selected = await selectWorktree(ctx, "Switch to worktree", candidates, currentPath);
	if (!selected) return;
	const latest = await revalidateWorktreeIdentity(pi, ctx, selected);
	if (
		latest.bare ||
		latest.prunableReason !== undefined ||
		!existsSync(latest.path) ||
		pathsEqual(latest.path, currentPath)
	) {
		throw new Error("The selected worktree changed state; select it again.");
	}
	await switchToWorktree(ctx, latest.path);
}

async function removeFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
	currentPath: string,
): Promise<void> {
	const candidates = records.filter(
		(record) => !record.isMain && !record.bare && !pathsEqual(record.path, currentPath),
	);
	const selected = await selectWorktree(
		ctx,
		"Remove clean linked worktree",
		candidates,
		currentPath,
	);
	if (!selected) return;
	if (selected.lockedReason !== undefined) {
		throw new Error(
			`Worktree is locked${selected.lockedReason ? `: ${selected.lockedReason}` : "."} Unlock it explicitly with Git before removal.`,
		);
	}
	if (selected.prunableReason !== undefined || !existsSync(selected.path)) {
		throw new Error("The selected worktree path is stale. Use prune instead of remove.");
	}

	const inventory = await worktreeInventory(pi, selected.path, ctx.signal);
	if (inventory.length > 0) {
		throw new Error(
			`Removal refused because ${selected.path} contains tracked, untracked, ignored, or submodule data:\n${inventory.join("\n")}`,
		);
	}
	await assertDetachedHeadIsDurable(pi, ctx, selected);
	await assertAdministrativeHistoryIsDurable(
		pi,
		ctx,
		await worktreeAdministrativeDirectory(pi, selected.path, ctx.signal),
	);
	if (
		!(await ctx.ui.confirm(
			"Remove Git worktree",
			stripTerminalControls(
				`Delete the clean worktree directory ${selected.path}? The branch will be preserved.`,
			),
		))
	) {
		return;
	}

	const beforeRemoval = await listWorktrees(pi, ctx.cwd, ctx.signal);
	const latest = beforeRemoval.find((record) => pathsEqual(record.path, selected.path));
	if (!latest) throw new Error(`Worktree ${selected.path} is no longer registered.`);
	if (!sameWorktreeIdentity(selected, latest)) {
		throw new Error(`Worktree ${selected.path} changed identity; select it again.`);
	}
	if (latest.isMain || latest.lockedReason !== undefined || latest.prunableReason !== undefined) {
		throw new Error(
			`Worktree ${selected.path} changed state after confirmation; removal was refused.`,
		);
	}
	const latestInventory = await worktreeInventory(pi, latest.path, ctx.signal);
	if (latestInventory.length > 0) {
		throw new Error(
			`Removal refused because new local data appeared after confirmation:\n${latestInventory.join("\n")}`,
		);
	}
	await assertDetachedHeadIsDurable(pi, ctx, latest);
	await assertAdministrativeHistoryIsDurable(
		pi,
		ctx,
		await worktreeAdministrativeDirectory(pi, latest.path, ctx.signal),
	);
	await removeWorktree(pi, ctx.cwd, latest.path, ctx.signal);
	const updated = await listWorktrees(pi, ctx.cwd, ctx.signal);
	if (updated.some((record) => pathsEqual(record.path, selected.path))) {
		throw new Error(`Git remove returned success, but ${selected.path} is still registered.`);
	}
	safeNotify(ctx, `Removed worktree ${selected.path}. Its branch was preserved.`, "info");
}

async function pruneFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
): Promise<void> {
	for (const record of records.filter(
		(candidate) => candidate.prunableReason !== undefined && candidate.detached,
	)) {
		await assertDetachedHeadIsDurable(pi, ctx, record);
	}
	const preview = await prunePreview(pi, ctx.cwd, ctx.signal);
	if (!preview) {
		ctx.ui.notify("Git found no stale worktree metadata to prune.", "info");
		return;
	}
	await assertAdministrativePruneCandidatesAreDurable(pi, ctx);
	const safePreview = stripTerminalControls(preview);
	ctx.ui.notify(`git worktree prune --dry-run --verbose\n${safePreview}`, "warning");
	if (!(await ctx.ui.confirm("Prune stale worktree metadata", safePreview))) return;
	const latest = await listWorktrees(pi, ctx.cwd, ctx.signal);
	for (const record of latest.filter(
		(candidate) => candidate.prunableReason !== undefined && candidate.detached,
	)) {
		await assertDetachedHeadIsDurable(pi, ctx, record);
	}
	await assertAdministrativePruneCandidatesAreDurable(pi, ctx);
	const output = await pruneWorktrees(pi, ctx.cwd, ctx.signal);
	safeNotify(
		ctx,
		output ? `Pruned stale worktree metadata:\n${output}` : "Pruned stale worktree metadata.",
		"info",
	);
}

async function assertAdministrativePruneCandidatesAreDurable(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	for (const candidate of await administrativePruneCandidates(pi, ctx.cwd, ctx.signal)) {
		if (candidate.indexDirty) {
			throw new Error(
				`Prune refused because administrative worktree ${candidate.id} contains staged-only index changes.`,
			);
		}
		await assertAdministrativeHistoryIsDurable(pi, ctx, candidate.administrativePath);
		if (candidate.head) {
			const refs = await durableRefsContaining(pi, ctx.cwd, candidate.head, ctx.signal);
			if (refs.length === 0) {
				throw new Error(
					`Prune refused because administrative worktree ${candidate.id} has detached HEAD ${candidate.head}, which is not reachable from a durable ref.`,
				);
			}
			continue;
		}
		if (
			!candidate.branchRef ||
			!(await durableRefExists(pi, ctx.cwd, candidate.branchRef, ctx.signal))
		) {
			throw new Error(
				`Prune refused because administrative worktree ${candidate.id} does not resolve to a durable ref.`,
			);
		}
	}
}

async function assertAdministrativeHistoryIsDurable(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	administrativePath: string,
): Promise<void> {
	for (const oid of await administrativeHistoryOids(pi, ctx.cwd, administrativePath, ctx.signal)) {
		const refs = await durableRefsContaining(pi, ctx.cwd, oid, ctx.signal);
		if (refs.length === 0) {
			throw new Error(
				`Operation refused because worktree administrative history contains ${oid}, which is not reachable from a durable ref. Create a branch or tag for it first.`,
			);
		}
	}
}

async function assertDetachedHeadIsDurable(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	record: WorktreeRecord,
): Promise<void> {
	if (!record.detached) return;
	if (!record.head)
		throw new Error(`Detached worktree ${record.path} has no HEAD object; refusing.`);
	const refs = await durableRefsContaining(pi, ctx.cwd, record.head, ctx.signal);
	if (refs.length === 0) {
		throw new Error(
			`Detached HEAD ${record.head} at ${record.path} is not reachable from a local branch, tag, or remote ref. Preserve it before continuing.`,
		);
	}
}

async function revalidateWorktreeIdentity(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selected: WorktreeRecord,
): Promise<WorktreeRecord> {
	const latest = (await listWorktrees(pi, ctx.cwd, ctx.signal)).find((record) =>
		pathsEqual(record.path, selected.path),
	);
	if (!latest) throw new Error(`Worktree ${selected.path} is no longer registered.`);
	if (!sameWorktreeIdentity(selected, latest)) {
		throw new Error(`Worktree ${selected.path} changed identity; select it again.`);
	}
	return latest;
}

async function selectWorktree(
	ctx: ExtensionCommandContext,
	title: string,
	records: readonly WorktreeRecord[],
	currentPath: string,
): Promise<WorktreeRecord | undefined> {
	if (records.length === 0) {
		ctx.ui.notify("No eligible worktrees are available for this action.", "info");
		return undefined;
	}
	const labels = records.map(
		(record, index) => `${index + 1}. ${formatWorktree(record, currentPath)}`,
	);
	const selected = await ctx.ui.select(title, labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	return index < 0 ? undefined : records[index];
}

function safeNotify(
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	try {
		ctx.ui.notify(stripTerminalControls(message), level);
	} catch {
		console.error(message);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
