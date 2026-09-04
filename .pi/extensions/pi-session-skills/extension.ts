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

export function registerSessionSkills(
	pi: ExtensionAPI,
	options: SessionSkillsExtensionOptions = {},
): void {
	const resolver = options.resolver ?? new SessionSkillResolver();
	const activations = new Map<string, SessionSkillActivation>();
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let generation = 0;
	let currentOperation: RunningOperation | undefined;

	const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

	const requireCommandContext = (ctx: ExtensionCommandContext): void => {
		if (!ctx.hasUI) throw new Error("/session-skills requires TUI or RPC mode.");
		if (!ownsSession(ctx)) throw new Error("/session-skills is unavailable for a stale session.");
	};

	const saveSnapshot = (): void => {
		const snapshot: ActivationSnapshot = {
			version: 1,
			skills: [...activations.values()],
		};
		pi.appendEntry(ACTIVATION_ENTRY_TYPE, snapshot);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (activeSession && activeSession !== ctx.sessionManager && ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		const startGeneration = ++generation;
		const previousOperation = currentOperation;
		previousOperation?.controller.abort();
		if (previousOperation) await previousOperation.settled;
		if (generation !== startGeneration) return;
		currentOperation = undefined;
		activeSession = ctx.sessionManager;
		activations.clear();

		const snapshot = latestSnapshot(ctx.sessionManager.getBranch());
		const missing: string[] = [];
		for (const activation of snapshot?.skills ?? []) {
			if (isUsableActivation(activation, resolver.getCacheRoot())) {
				activations.set(activation.name, activation);
			} else if (typeof activation?.name === "string") {
				missing.push(sanitizeDisplay(activation.name));
			}
		}
		if (missing.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Skipped missing or unsafe session skills: ${missing.join(", ")}`, "warning");
		}
	});

	pi.on("resources_discover", (_event, ctx) => {
		if (!ownsSession(ctx) || activations.size === 0) return {};
		return { skillPaths: [...activations.values()].map((activation) => activation.path) };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		generation++;
		const operation = currentOperation;
		operation?.controller.abort();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		if (operation) await operation.settled;
		if (!ownsSession(ctx)) return;
		currentOperation = undefined;
		activeSession = undefined;
		activations.clear();
	});

	const loadSkill = async (
		command: LoadCommandArguments,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		if (currentOperation) throw new Error("Another session skill operation is already running.");
		const source = parseSkillSource(command.source, ctx.cwd);
		const selector = resolveSkillSelector(source, command.skill);
		const commandGeneration = generation;
		const commandSession = ctx.sessionManager;
		const controller = new AbortController();

		if (source.kind === "git") {
			ctx.ui.notify(
				"Remote skills contain instructions and code that run with your full Pi permissions. Review them before use.",
				"warning",
			);
		}
		ctx.ui.setStatus(STATUS_KEY, "Resolving session skill…");

		let result: ResolvedSessionSkill;
		const resolution = Promise.resolve().then(() =>
			resolver.resolve({
				source,
				selector,
				refresh: command.refresh,
				signal: controller.signal,
			}),
		);
		const operation: RunningOperation = {
			controller,
			settled: resolution.then(
				() => {},
				() => {},
			),
		};
		currentOperation = operation;
		try {
			result = await resolution;
			if (
				generation !== commandGeneration ||
				activeSession !== commandSession ||
				controller.signal.aborted
			) {
				throw new Error("Session changed while the skill was resolving.");
			}
		} catch (error) {
			throw new Error(formatResolverError(error));
		} finally {
			if (currentOperation === operation) currentOperation = undefined;
			if (ownsSession(ctx) && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		const existing = activations.get(result.name);
		if (
			!command.refresh &&
			existing?.path === result.path &&
			existing.source === result.source &&
			existing.selector === result.selector
		) {
			ctx.ui.notify(`Skill already active: ${sanitizeDisplay(result.name)}`, "info");
			return;
		}

		const ownPaths = new Set([...activations.values()].map((activation) => activation.path));
		const conflict = ctx
			.getSystemPromptOptions()
			.skills?.find((skill) => skill.name === result.name && !ownPaths.has(skill.baseDir));
		if (conflict) {
			throw new Error(
				`Skill "${sanitizeDisplay(result.name)}" is already provided by ${sanitizeDisplay(conflict.filePath)}.`,
			);
		}

		activations.set(result.name, {
			name: result.name,
			path: result.path,
			source: result.source,
			selector: result.selector,
		});
		saveSnapshot();
		ctx.ui.notify(
			`${result.cacheHit ? "Activated cached" : "Loaded"} skill: ${sanitizeDisplay(result.name)}`,
			"info",
		);
		await ctx.reload();
	};

	const showSkills = (ctx: ExtensionCommandContext, includeUsage: boolean): void => {
		const lines = activations.size === 0 ? ["Session skills: none"] : ["Session skills:"];
		for (const activation of activations.values()) {
			lines.push(`  ${sanitizeDisplay(activation.name)}`);
			lines.push(`    source: ${sanitizeDisplay(activation.source)}`);
			lines.push(`    cache: ${sanitizeDisplay(activation.path)}`);
		}
		if (includeUsage) lines.push("", SESSION_SKILLS_USAGE);
		ctx.ui.notify(lines.join("\n"), "info");
	};

	const unloadSkill = async (
		command: UnloadCommandArguments,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		if (currentOperation) throw new Error("Another session skill operation is already running.");
		let changed = false;
		let message: string;
		if (command.all) {
			const count = activations.size;
			activations.clear();
			changed = count > 0;
			message = changed
				? `Unloaded ${count} session skill${count === 1 ? "" : "s"}.`
				: "No session skills loaded.";
		} else {
			const name = command.name ?? "";
			changed = activations.delete(name);
			message = changed
				? `Unloaded skill: ${sanitizeDisplay(name)}`
				: `Session skill not loaded: ${sanitizeDisplay(name)}`;
		}
		ctx.ui.notify(message, changed ? "info" : "warning");
		if (!changed) return;
		saveSnapshot();
		await ctx.reload();
	};

	pi.registerCommand("session-skills", {
		description: "Manage skills loaded into the current session",
		getArgumentCompletions: (prefix) => commandCompletions(prefix, activations.keys()),
		handler: async (rawArguments, ctx) => {
			requireCommandContext(ctx);
			const command = parseSessionSkillsCommandArguments(rawArguments);
			switch (command.action) {
				case "status":
					showSkills(ctx, true);
					return;
				case "list":
					showSkills(ctx, false);
					return;
				case "load":
					await loadSkill(command, ctx);
					return;
				case "unload":
					await unloadSkill(command, ctx);
					return;
			}
		},
	});
}

export default function sessionSkills(pi: ExtensionAPI): void {
	registerSessionSkills(pi);
}

function commandCompletions(
	prefix: string,
	activeNames: Iterable<string>,
): Array<{ value: string; label: string }> | null {
	const input = prefix.trimStart();
	if (!/\s/u.test(input)) {
		const routes = ["load", "list", "unload"]
			.filter((route) => route.startsWith(input))
			.map((route) => ({ value: route, label: route }));
		return routes.length > 0 ? routes : null;
	}
	const unload = input.match(/^unload\s+([^\s]*)$/u);
	if (!unload) return null;
	const valuePrefix = unload[1];
	const values = ["--all", ...activeNames]
		.filter((value) => value.startsWith(valuePrefix))
		.map((value) => ({ value: `unload ${value}`, label: value }));
	return values.length > 0 ? values : null;
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
		const detail = sanitizeDisplay(error.output).trim().slice(-2_000);
		return detail ? `${error.message}\n${detail}` : error.message;
	}
	return sanitizeDisplay(error instanceof Error ? error.message : String(error));
}

function sanitizeDisplay(value: string): string {
	return [...stripTerminalSequences(value)]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			const unsafe =
				(codePoint <= 0x1f && character !== "\n" && character !== "\t") ||
				(codePoint >= 0x7f && codePoint <= 0x9f) ||
				(codePoint >= 0x202a && codePoint <= 0x202e) ||
				(codePoint >= 0x2066 && codePoint <= 0x2069);
			return unsafe ? " " : character;
		})
		.join("")
		.trim();
}
