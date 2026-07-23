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
	unresolvableSymlinkAncestor,
	validateBranch,
	type WorktreeRecord,
	worktreeAdministrativeDirectory,
	worktreeForBranch,
	worktreeInventory,
} from "./git.js";
import { switchToWorktree } from "./session.js";

const ACTION_ADD = "Add worktree";
const ACTION_SWITCH = "Switch worktree";
const ACTION_REMOVE = "Remove worktree";
const ACTION_PRUNE = "Prune stale metadata";
const ACTIONS = [ACTION_ADD, ACTION_SWITCH, ACTION_REMOVE, ACTION_PRUNE];

interface AdministrativeHistoryRisk {
	label: string;
	oids: string[];
}

export function registerWorktreeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("worktree", {
		description: "Interactively add, switch, remove, or prune Git worktrees",
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
			stripTerminalControls(
				defaultStart
					? `Start point for ${branch} (blank uses ${defaultStart})`
					: `Start point for ${branch} (required because HEAD is detached)`,
			),
			stripTerminalControls(defaultStart ?? "commit-ish"),
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
	assertTargetFilesystemAvailable(targetPath);
	const pathCollision = records.find((record) => pathsEqual(record.path, targetPath));
	if (pathCollision) {
		throw new Error(`The target path is already registered as a worktree: ${pathCollision.path}.`);
	}

	const summary = branchExists
		? `Attach existing branch ${branch} at ${targetPath}?`
		: `Create branch ${branch} from ${startLabel} at ${targetPath}?`;
	if (!(await ctx.ui.confirm("Create Git worktree", stripTerminalControls(summary)))) return;

	assertTargetFilesystemAvailable(targetPath);
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

function assertTargetFilesystemAvailable(targetPath: string): void {
	if (pathEntryExists(targetPath)) {
		throw new Error(`The target path already exists: ${targetPath}.`);
	}
	const unsafeAncestor = unresolvableSymlinkAncestor(targetPath);
	if (unsafeAncestor) {
		throw new Error(
			`The target path has an unresolvable symbolic-link ancestor: ${unsafeAncestor}.`,
		);
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
	const selected = await selectWorktree(ctx, "Remove linked worktree", candidates, currentPath);
	if (!selected) return;
	if (selected.lockedReason !== undefined) {
		throw new Error(
			`Worktree is locked${selected.lockedReason ? `: ${selected.lockedReason}` : "."} Unlock it explicitly with Git before removal.`,
		);
	}
	if (selected.prunableReason !== undefined || !existsSync(selected.path)) {
		throw new Error("The selected worktree path is stale. Use prune instead of remove.");
	}

	const inventory = classifyRemovalInventory(
		await worktreeInventory(pi, selected.path, ctx.signal),
	);
	if (inventory.protected.length > 0) {
		throw new Error(
			`Removal refused because ${selected.path} contains tracked, untracked, index-flagged, or submodule data:\n${inventory.protected.join("\n")}`,
		);
	}
	await assertDetachedHeadIsDurable(pi, ctx, selected);
	const administrativePath = await worktreeAdministrativeDirectory(pi, selected.path, ctx.signal);
	const approvedHistoryRisks = historyRisks(
		selected.path,
		await unreachableAdministrativeHistoryOids(pi, ctx, administrativePath),
	);
	const recoveryWarning = formatAdministrativeRecoveryWarning(approvedHistoryRisks);
	const ignoredWarning = formatIgnoredDataWarning(inventory.ignored);
	const removalWarning =
		ignoredWarning && recoveryWarning
			? `${ignoredWarning}\n${recoveryWarning.trimStart()}`
			: `${ignoredWarning}${recoveryWarning}`;
	const confirmationTitle =
		inventory.ignored.length > 0
			? recoveryWarning
				? "Remove worktree and discard local/recovery data"
				: "Remove worktree and delete ignored files"
			: recoveryWarning
				? "Remove worktree and discard recovery history"
				: "Remove Git worktree";
	if (
		!(await ctx.ui.confirm(
			confirmationTitle,
			`Delete the worktree directory ${stripTerminalControls(selected.path)}? The branch will be preserved.${removalWarning}`,
		))
	) {
		return;
	}

	const latestAdministrativePath = await worktreeAdministrativeDirectory(
		pi,
		selected.path,
		ctx.signal,
	);
	const latestHistoryRisks = historyRisks(
		selected.path,
		await unreachableAdministrativeHistoryOids(pi, ctx, latestAdministrativePath),
	);
	if (
		!pathsEqual(administrativePath, latestAdministrativePath) ||
		!sameAdministrativeHistoryRisks(approvedHistoryRisks, latestHistoryRisks)
	) {
		throw new Error(
			`Worktree ${selected.path} administrative recovery history changed after confirmation; select it again.`,
		);
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
	await assertDetachedHeadIsDurable(pi, ctx, latest);
	const latestInventory = classifyRemovalInventory(
		await worktreeInventory(pi, latest.path, ctx.signal),
	);
	if (latestInventory.protected.length > 0) {
		throw new Error(
			`Removal refused because new protected local data appeared after confirmation:\n${latestInventory.protected.join("\n")}`,
		);
	}
	if (!sameInventory(inventory.ignored, latestInventory.ignored)) {
		throw new Error(
			`Removal refused because ignored data changed after confirmation:\n${latestInventory.ignored.join("\n") || "(none)"}`,
		);
	}
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
	const approvedHistoryRisks = await inspectAdministrativePruneCandidates(pi, ctx);
	const safePreview = stripTerminalControls(preview);
	const recoveryWarning = formatAdministrativeRecoveryWarning(approvedHistoryRisks);
	ctx.ui.notify(`git worktree prune --dry-run --verbose\n${safePreview}`, "warning");
	if (
		!(await ctx.ui.confirm(
			recoveryWarning
				? "Prune metadata and discard recovery history"
				: "Prune stale worktree metadata",
			stripTerminalControls(`${safePreview}${recoveryWarning}`),
		))
	) {
		return;
	}
	const latest = await listWorktrees(pi, ctx.cwd, ctx.signal);
	for (const record of latest.filter(
		(candidate) => candidate.prunableReason !== undefined && candidate.detached,
	)) {
		await assertDetachedHeadIsDurable(pi, ctx, record);
	}
	const latestHistoryRisks = await inspectAdministrativePruneCandidates(pi, ctx);
	const latestPreview = await prunePreview(pi, ctx.cwd, ctx.signal);
	if (
		latestPreview !== preview ||
		!sameAdministrativeHistoryRisks(approvedHistoryRisks, latestHistoryRisks)
	) {
		throw new Error("Stale worktree metadata changed after confirmation; run prune again.");
	}
	const output = await pruneWorktrees(pi, ctx.cwd, ctx.signal);
	safeNotify(
		ctx,
		output ? `Pruned stale worktree metadata:\n${output}` : "Pruned stale worktree metadata.",
		"info",
	);
}

async function inspectAdministrativePruneCandidates(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<AdministrativeHistoryRisk[]> {
	const risks: AdministrativeHistoryRisk[] = [];
	for (const candidate of await administrativePruneCandidates(pi, ctx.cwd, ctx.signal)) {
		if (candidate.indexDirty) {
			throw new Error(
				`Prune refused because administrative worktree ${candidate.id} contains staged-only index changes.`,
			);
		}
		if (candidate.head) {
			const refs = await durableRefsContaining(pi, ctx.cwd, candidate.head, ctx.signal);
			if (refs.length === 0) {
				throw new Error(
					`Prune refused because administrative worktree ${candidate.id} has detached HEAD ${candidate.head}, which is not reachable from a durable ref.`,
				);
			}
		} else if (
			!candidate.branchRef ||
			!(await durableRefExists(pi, ctx.cwd, candidate.branchRef, ctx.signal))
		) {
			throw new Error(
				`Prune refused because administrative worktree ${candidate.id} does not resolve to a durable ref.`,
			);
		}
		risks.push(
			...historyRisks(
				candidate.id,
				await unreachableAdministrativeHistoryOids(pi, ctx, candidate.administrativePath),
			),
		);
	}
	return normalizeAdministrativeHistoryRisks(risks);
}

async function unreachableAdministrativeHistoryOids(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	administrativePath: string,
): Promise<string[]> {
	const unreachable: string[] = [];
	for (const oid of await administrativeHistoryOids(pi, ctx.cwd, administrativePath, ctx.signal)) {
		const refs = await durableRefsContaining(pi, ctx.cwd, oid, ctx.signal);
		if (refs.length === 0) unreachable.push(oid);
	}
	return [...new Set(unreachable)].sort();
}

function historyRisks(label: string, oids: string[]): AdministrativeHistoryRisk[] {
	return oids.length > 0 ? [{ label, oids }] : [];
}

function normalizeAdministrativeHistoryRisks(
	risks: readonly AdministrativeHistoryRisk[],
): AdministrativeHistoryRisk[] {
	return risks
		.map((risk) => ({ label: risk.label, oids: [...new Set(risk.oids)].sort() }))
		.filter((risk) => risk.oids.length > 0)
		.sort((left, right) => left.label.localeCompare(right.label));
}

function sameAdministrativeHistoryRisks(
	left: readonly AdministrativeHistoryRisk[],
	right: readonly AdministrativeHistoryRisk[],
): boolean {
	return (
		JSON.stringify(normalizeAdministrativeHistoryRisks(left)) ===
		JSON.stringify(normalizeAdministrativeHistoryRisks(right))
	);
}

function formatAdministrativeRecoveryWarning(risks: readonly AdministrativeHistoryRisk[]): string {
	if (risks.length === 0) return "";
	const entries = risks
		.map(
			(risk) =>
				`${stripTerminalControls(risk.label)}: ${risk.oids.map(stripTerminalControls).join(", ")}`,
		)
		.join("; ");
	return ` Administrative recovery warning: these commits are not reachable from a branch, tag, or remote ref: ${entries}. Discarding their recovery pointers means they may later be garbage-collected.`;
}

interface RemovalInventory {
	ignored: string[];
	protected: string[];
}

function classifyRemovalInventory(lines: readonly string[]): RemovalInventory {
	const ignored: string[] = [];
	const protectedData: string[] = [];
	for (const line of lines) {
		(line.startsWith("!! ") ? ignored : protectedData).push(line);
	}
	return {
		ignored: normalizeInventory(ignored),
		protected: normalizeInventory(protectedData),
	};
}

function normalizeInventory(lines: readonly string[]): string[] {
	return [...new Set(lines)].sort();
}

function sameInventory(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify(normalizeInventory(left)) === JSON.stringify(normalizeInventory(right));
}

function formatIgnoredDataWarning(ignored: readonly string[]): string {
	if (ignored.length === 0) return "";
	return ` Ignored files and directories that will be deleted:\n${ignored.map(stripTerminalControls).join("\n")}`;
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
