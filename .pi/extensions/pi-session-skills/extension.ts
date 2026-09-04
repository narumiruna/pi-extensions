import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	loadSkills,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	type LoadCommandArguments,
	parseSessionSkillsCommandArguments,
	SESSION_SKILLS_USAGE,
	type UnloadCommandArguments,
} from "./command-parser.js";
import {
	GitCommandError,
	isPathInside,
	type ResolvedSessionSkill,
	SessionSkillResolver,
	type SkillResolverLike,
} from "./resolver.js";
import { parseSkillSource, resolveSkillSelector } from "./source-parser.js";

export const ACTIVATION_ENTRY_TYPE = "pi-session-skills:activation-v1";
export const STATUS_KEY = "session-skills";

interface SessionSkillActivation {
	name: string;
	path: string;
	source: string;
	selector?: string;
}

interface ActivationSnapshot {
	version: 1;
	skills: SessionSkillActivation[];
}

interface RestoredActivationSnapshot {
	version: 1;
	skills: Array<Partial<SessionSkillActivation> | undefined>;
}

export interface SessionSkillsExtensionOptions {
	resolver?: SkillResolverLike;
}

interface RunningOperation {
	controller: AbortController;
	settled: Promise<void>;
}

interface SessionState {
	activations: Map<string, SessionSkillActivation>;
	generation: number;
	operation?: RunningOperation;
}

export function registerSessionSkills(
	pi: ExtensionAPI,
	options: SessionSkillsExtensionOptions = {},
): void {
	const resolver = options.resolver ?? new SessionSkillResolver();
	const sessionStates = new Map<ExtensionContext["sessionManager"], SessionState>();

	const requireCommandContext = (ctx: ExtensionCommandContext): SessionState => {
		if (!ctx.hasUI) throw new Error("/session-skills requires TUI or RPC mode.");
		const state = sessionStates.get(ctx.sessionManager);
		if (!state) throw new Error("/session-skills is unavailable for a stale session.");
		return state;
	};

	const saveSnapshot = (state: SessionState): void => {
		const snapshot: ActivationSnapshot = {
			version: 1,
			skills: [...state.activations.values()],
		};
		pi.appendEntry(ACTIVATION_ENTRY_TYPE, snapshot);
	};

	pi.on("session_start", async (_event, ctx) => {
		let state = sessionStates.get(ctx.sessionManager);
		if (!state) {
			state = { activations: new Map(), generation: 0 };
			sessionStates.set(ctx.sessionManager, state);
		}
		const startGeneration = ++state.generation;
		const previousOperation = state.operation;
		previousOperation?.controller.abort();
		if (previousOperation) await previousOperation.settled;
		if (sessionStates.get(ctx.sessionManager) !== state || state.generation !== startGeneration) {
			return;
		}
		state.operation = undefined;
		state.activations.clear();

		const snapshot = latestSnapshot(ctx.sessionManager.getBranch());
		const nativeSkillNames = getNonSessionSkillNames(pi, resolver.getCacheRoot());
		const skipped: string[] = [];
		for (const activation of snapshot?.skills ?? []) {
			if (
				isUsableActivation(activation, resolver.getCacheRoot()) &&
				!nativeSkillNames.has(activation.name)
			) {
				state.activations.set(activation.name, activation);
			} else if (typeof activation?.name === "string") {
				skipped.push(sanitizeDisplayLine(activation.name));
			}
		}
		if (skipped.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`Skipped missing, unsafe, or conflicting session skills: ${skipped.join(", ")}`,
				"warning",
			);
		}
	});

	pi.on("resources_discover", (_event, ctx) => {
		const state = sessionStates.get(ctx.sessionManager);
		if (!state || state.activations.size === 0) return {};
		return { skillPaths: [...state.activations.values()].map((activation) => activation.path) };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = sessionStates.get(ctx.sessionManager);
		if (!state) return;
		const shutdownGeneration = ++state.generation;
		const operation = state.operation;
		operation?.controller.abort();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		if (operation) await operation.settled;
		if (
			sessionStates.get(ctx.sessionManager) !== state ||
			state.generation !== shutdownGeneration
		) {
			return;
		}
		sessionStates.delete(ctx.sessionManager);
		state.activations.clear();
	});

	const loadSkill = async (
		command: LoadCommandArguments,
		ctx: ExtensionCommandContext,
		state: SessionState,
	): Promise<void> => {
		if (state.operation) throw new Error("Another session skill operation is already running.");
		const source = parseSkillSource(command.source, ctx.cwd);
		const selector = resolveSkillSelector(source, command.skill);
		const commandGeneration = state.generation;
		const controller = new AbortController();

		if (source.kind === "git") {
			ctx.ui.notify(
				"Remote skills contain instructions and code that run with your full Pi permissions. Review them before use.",
				"warning",
			);
		}
		ctx.ui.setStatus(STATUS_KEY, "Resolving session skill…");

		let result: ResolvedSessionSkill | undefined;
		let prepared = false;
		const resolution = Promise.resolve().then(() =>
			resolver.resolve({
				source,
				selector,
				refresh: command.refresh,
				signal: controller.signal,
			}),
		);
		let settleOperation!: () => void;
		const operation: RunningOperation = {
			controller,
			settled: new Promise<void>((resolve) => {
				settleOperation = resolve;
			}),
		};
		state.operation = operation;
		try {
			result = await resolution;
			assertCurrentSessionState(sessionStates, ctx, state, commandGeneration, controller.signal);

			const existing = state.activations.get(result.name);
			if (
				!command.refresh &&
				existing?.path === result.path &&
				existing.source === result.source &&
				existing.selector === result.selector
			) {
				await result.transaction?.rollback();
				assertCurrentSessionState(sessionStates, ctx, state, commandGeneration, controller.signal);
				ctx.ui.notify(`Skill already active: ${sanitizeDisplayLine(result.name)}`, "info");
				return;
			}

			const ownPaths = new Set(
				[...state.activations.values()].map((activation) => activation.path),
			);
			const resultName = result.name;
			const conflict = ctx
				.getSystemPromptOptions()
				.skills?.find((skill) => skill.name === resultName && !ownPaths.has(skill.baseDir));
			if (conflict) {
				throw new Error(
					`Skill "${sanitizeDisplayLine(result.name)}" is already provided by ${sanitizeDisplayLine(conflict.filePath)}.`,
				);
			}

			const previousActivations = new Map(state.activations);
			await result.transaction?.commit();
			assertCurrentSessionState(sessionStates, ctx, state, commandGeneration, controller.signal);
			for (const [name, activation] of state.activations) {
				if (activation.source === result.source && activation.selector === result.selector) {
					state.activations.delete(name);
				}
			}
			state.activations.set(result.name, {
				name: result.name,
				path: result.path,
				source: result.source,
				...(result.selector === undefined ? {} : { selector: result.selector }),
			});
			try {
				saveSnapshot(state);
			} catch (error) {
				restoreActivations(state, previousActivations);
				throw error;
			}
			prepared = true;
		} catch (error) {
			let failure = error;
			if (!prepared && result?.transaction) {
				try {
					await result.transaction.rollback();
				} catch (rollbackError) {
					failure = new Error(
						`${formatResolverError(error)} Cache rollback failed: ${formatResolverError(rollbackError)}`,
					);
				}
			}
			throw new Error(formatResolverError(failure));
		} finally {
			settleOperation();
			if (state.operation === operation) state.operation = undefined;
			if (sessionStates.get(ctx.sessionManager) === state && ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		}

		ctx.ui.notify(`Reloading to activate skill: ${sanitizeDisplayLine(result.name)}`, "info");
		await ctx.reload();
	};

	const showSkills = (
		ctx: ExtensionCommandContext,
		state: SessionState,
		includeUsage: boolean,
	): void => {
		const lines = state.activations.size === 0 ? ["Session skills: none"] : ["Session skills:"];
		for (const activation of state.activations.values()) {
			lines.push(`  ${sanitizeDisplayLine(activation.name)}`);
			lines.push(`    source: ${sanitizeDisplayLine(activation.source)}`);
			lines.push(`    cache: ${sanitizeDisplayLine(activation.path)}`);
		}
		if (includeUsage) lines.push("", SESSION_SKILLS_USAGE);
		ctx.ui.notify(lines.join("\n"), "info");
	};

	const unloadSkill = async (
		command: UnloadCommandArguments,
		ctx: ExtensionCommandContext,
		state: SessionState,
	): Promise<void> => {
		if (state.operation) throw new Error("Another session skill operation is already running.");
		const previousActivations = new Map(state.activations);
		let changed = false;
		if (command.all) {
			changed = state.activations.size > 0;
			state.activations.clear();
		} else {
			changed = state.activations.delete(command.name ?? "");
		}
		if (!changed) {
			ctx.ui.notify("No matching session skills are loaded.", "warning");
			return;
		}
		try {
			saveSnapshot(state);
		} catch (error) {
			restoreActivations(state, previousActivations);
			throw error;
		}
		ctx.ui.notify("Reloading to apply session skill changes.", "info");
		await ctx.reload();
	};

	pi.registerCommand("session-skills", {
		description: "Manage skills loaded into the current session",
		getArgumentCompletions: commandCompletions,
		handler: async (rawArguments, ctx) => {
			const state = requireCommandContext(ctx);
			const command = parseSessionSkillsCommandArguments(rawArguments);
			switch (command.action) {
				case "status":
					showSkills(ctx, state, true);
					return;
				case "list":
					showSkills(ctx, state, false);
					return;
				case "load":
					await loadSkill(command, ctx, state);
					return;
				case "unload":
					await unloadSkill(command, ctx, state);
					return;
			}
		},
	});
}

export default function sessionSkills(pi: ExtensionAPI): void {
	registerSessionSkills(pi);
}

function commandCompletions(prefix: string): Array<{ value: string; label: string }> | null {
	const input = prefix.trimStart();
	if (!/\s/u.test(input)) {
		const routes = ["load", "list", "unload"]
			.filter((route) => route.startsWith(input))
			.map((route) => ({ value: route, label: route }));
		return routes.length > 0 ? routes : null;
	}
	if (input.startsWith("load ")) {
		const lastSpace = input.lastIndexOf(" ");
		const valuePrefix = input.slice(lastSpace + 1);
		if (valuePrefix && !valuePrefix.startsWith("-")) return null;
		const base = input.slice(0, lastSpace + 1);
		const used = new Set(base.trim().split(/\s+/u));
		const values = ["--skill", "--refresh"]
			.filter((value) => !used.has(value) && value.startsWith(valuePrefix))
			.map((value) => ({ value: `${base}${value}`, label: value }));
		return values.length > 0 ? values : null;
	}
	const unload = input.match(/^unload\s+(--[^\s]*)$/u);
	if (!unload || !"--all".startsWith(unload[1])) return null;
	return [{ value: "unload --all", label: "--all" }];
}

function assertCurrentSessionState(
	states: Map<ExtensionContext["sessionManager"], SessionState>,
	ctx: ExtensionContext,
	state: SessionState,
	generation: number,
	signal: AbortSignal,
): void {
	if (
		states.get(ctx.sessionManager) !== state ||
		state.generation !== generation ||
		signal.aborted
	) {
		throw new Error("Session changed while the skill was resolving.");
	}
}

function restoreActivations(
	state: SessionState,
	previous: Map<string, SessionSkillActivation>,
): void {
	state.activations.clear();
	for (const [name, activation] of previous) state.activations.set(name, activation);
}

function getNonSessionSkillNames(pi: ExtensionAPI, cacheRoot: string): Set<string> {
	const names = new Set<string>();
	for (const command of pi.getCommands()) {
		if (command.source !== "skill" || isPathInside(cacheRoot, command.sourceInfo.path)) continue;
		names.add(
			command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name,
		);
	}
	return names;
}

function latestSnapshot(entries: SessionEntry[]): RestoredActivationSnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== ACTIVATION_ENTRY_TYPE) continue;
		const data = entry.data as Partial<RestoredActivationSnapshot> | undefined;
		if (data?.version !== 1 || !Array.isArray(data.skills)) return { version: 1, skills: [] };
		return { version: 1, skills: data.skills };
	}
	return undefined;
}

function isUsableActivation(
	activation: Partial<SessionSkillActivation> | undefined,
	cacheRoot: string,
): activation is SessionSkillActivation {
	if (
		typeof activation?.name !== "string" ||
		typeof activation.path !== "string" ||
		typeof activation.source !== "string" ||
		(activation.selector !== undefined && typeof activation.selector !== "string") ||
		!isPathInside(join(cacheRoot, "entries"), activation.path) ||
		!existsSync(join(activation.path, "SKILL.md"))
	) {
		return false;
	}
	try {
		if (!isPathInside(realpathSync(join(cacheRoot, "entries")), realpathSync(activation.path))) {
			return false;
		}
		const loaded = loadSkills({
			cwd: cacheRoot,
			agentDir: cacheRoot,
			skillPaths: [activation.path],
			includeDefaults: false,
		});
		return loaded.skills.length === 1 && loaded.skills[0].name === activation.name;
	} catch {
		return false;
	}
}

function formatResolverError(error: unknown): string {
	if (error instanceof GitCommandError) {
		const detail = sanitizeDiagnostic(error.output).trim().slice(-2_000);
		const message = sanitizeDisplayLine(error.message);
		return detail ? `${message}\n${detail}` : message;
	}
	return sanitizeDisplayLine(error instanceof Error ? error.message : String(error));
}

function sanitizeDisplayLine(value: string): string {
	return sanitizeCharacters(value, false);
}

function sanitizeDiagnostic(value: string): string {
	return sanitizeCharacters(value, true);
}

function sanitizeCharacters(value: string, preserveNewlines: boolean): string {
	return [...stripTerminalSequences(value)]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			const unsafe =
				(codePoint <= 0x1f && !(preserveNewlines && character === "\n")) ||
				(codePoint >= 0x7f && codePoint <= 0x9f) ||
				(codePoint >= 0x202a && codePoint <= 0x202e) ||
				(codePoint >= 0x2066 && codePoint <= 0x2069);
			return unsafe ? " " : character;
		})
		.join("")
		.trim();
}
