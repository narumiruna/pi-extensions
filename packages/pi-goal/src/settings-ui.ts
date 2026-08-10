import { join } from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkpointGoalActiveTime } from "./accounting.js";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import { abortCurrentTurn, type GoalRuntime, STATUS_KEY } from "./runtime.js";
import {
	DEFAULT_GOAL_SETTINGS,
	GOAL_SETTINGS_FILE,
	type GoalSettings,
	saveGoalSettings,
} from "./settings.js";

interface GoalSettingsUiOptions {
	settingsPath?: string;
	initialScreen?: "settings" | "automatic";
	save?: (settings: GoalSettings, settingsPath: string) => void;
	onQueueUnfrozen?: (ctx: ExtensionCommandContext) => Promise<void>;
}

interface GoalSettingsApplyOptions {
	save?: (settings: GoalSettings) => void;
}

type LimitField = "automaticTurns" | "noProgressTurns";
type LimitSelection = "unlimited" | "default" | "custom" | "off";
type DelaySelection = "custom" | "off";
export async function showGoalSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions = {},
) {
	const settingsPath = options.settingsPath ?? join(getAgentDir(), GOAL_SETTINGS_FILE);
	if (ctx.mode !== "tui") {
		notifyTerminal(
			ctx.ui,
			`Edit pi-goal settings manually: ${safeTerminalText(settingsPath)}`,
			"info",
		);
		return;
	}
	const generation = runtime.menuGeneration;
	const isMenuCurrent = () =>
		generation === runtime.menuGeneration && !runtime.menuController.signal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isMenuCurrent()) return;
	const invalid = runtime.settingsLoadIssue?.kind === "invalid";
	const previewGoalIds = new Map<LimitField, string | null>();
	type Screen =
		| "settings"
		| "automatic"
		| "no-progress"
		| "continuation-delay"
		| "invalid";
	type Action =
		| "open-automatic"
		| "open-no-progress"
		| "open-continuation-delay"
		| "choose-automatic"
		| "choose-no-progress"
		| "choose-continuation-delay"
		| "set-visibility"
		| "set-queue"
		| "set-rpc";
	const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
		start: invalid ? "invalid" : (options.initialScreen ?? "settings"),
		screens: {
			settings: () => ({
				kind: "settings",
				title: "Pi Goal Settings",
				lines: [`User settings · ${safeTerminalText(settingsPath)}`],
				items: [
					{
						id: "automaticTurns",
						label: "Automatic-work limit",
						description: "Pause automatic Goal work after a visible number of model responses.",
						currentValue: formatAutomaticSettingValue(
							runtime.settings.continuationLimits.automaticTurns,
						),
						action: "open-automatic",
					},
					{
						id: "noProgressTurns",
						label: "No-progress guard",
						description: "Pause after repeated or empty tool-free automatic runs.",
						currentValue: formatNoProgressSettingValue(
							runtime.settings.continuationLimits.noProgressTurns,
						),
						action: "open-no-progress",
					},
					{
						id: "minIntervalMs",
						label: "Continuation delay",
						description: "Wait before dispatching each eligible automatic continuation.",
						currentValue: formatContinuationDelay(
							runtime.settings.continuationLimits.minIntervalMs,
						),
						action: "open-continuation-delay",
					},
					{
						id: "toolVisibility",
						label: "Goal tools",
						description: "Keep terminal Goal tools visible, or reveal them after the first goal.",
						currentValue: visibilityLabel(runtime.settings.toolVisibility),
						values: ["Always", "After first goal"],
						action: "set-visibility",
					},
					{
						id: "experimentalGoals",
						label: "Ordered goal queue",
						description: "Enable experimental add, prioritize, skip, and drop-last workflows.",
						currentValue: runtime.settings.experimental.goals ? "Experimental" : "Off",
						values: ["Off", "Experimental"],
						action: "set-queue",
					},
					{
						id: "rpcEnabled",
						label: "Managed run RPC",
						description:
							"Allow trusted installed extensions to start and cancel Goal runs; this is not an extension sandbox.",
						currentValue: runtime.settings.rpc.enabled ? "On" : "Off",
						values: ["Off", "On"],
						action: "set-rpc",
					},
				],
			}),
			automatic: () => limitChoiceScreen(runtime, "automaticTurns", "choose-automatic"),
			"no-progress": () => limitChoiceScreen(runtime, "noProgressTurns", "choose-no-progress"),
			"continuation-delay": () => continuationDelayChoiceScreen(runtime),
			invalid: () => ({
				kind: "detail",
				title: "Pi Goal Settings · Read only",
				lines: [
					`Invalid settings file. Pi-goal is using built-in defaults. Fix ${safeTerminalText(settingsPath)} and run /reload. The file will not be overwritten.`,
					`Automatic-work limit: ${formatAutomaticWork(runtime.settings.continuationLimits.automaticTurns)}`,
					`No-progress guard: ${formatNoProgressProtection(runtime.settings.continuationLimits.noProgressTurns)}`,
					`Continuation delay: ${formatContinuationDelay(
						runtime.settings.continuationLimits.minIntervalMs,
					)}`,
					`Goal tools: ${visibilityLabel(runtime.settings.toolVisibility)}`,
					`Ordered goal queue: ${runtime.settings.experimental.goals ? "Experimental" : "Off"}`,
					`Managed run RPC: ${runtime.settings.rpc.enabled ? "On" : "Off"}`,
				],
				hint: "back",
			}),
		},
		actions: {
			"open-automatic": async () => {
				previewGoalIds.set("automaticTurns", runtime.activeGoal?.id ?? null);
				return { kind: "to", screen: "automatic" };
			},
			"open-no-progress": async () => {
				previewGoalIds.set("noProgressTurns", runtime.activeGoal?.id ?? null);
				return { kind: "to", screen: "no-progress" };
			},
			"open-continuation-delay": async () => ({
				kind: "to",
				screen: "continuation-delay",
			}),
			"choose-automatic": async ({ itemId }) =>
				applyLimitChoice(
					runtime,
					ctx,
					options,
					settingsPath,
					"automaticTurns",
					itemId,
					previewGoalIds.get("automaticTurns") ?? null,
					isMenuCurrent,
				),
			"choose-no-progress": async ({ itemId }) =>
				applyLimitChoice(
					runtime,
					ctx,
					options,
					settingsPath,
					"noProgressTurns",
					itemId,
					previewGoalIds.get("noProgressTurns") ?? null,
					isMenuCurrent,
				),
			"choose-continuation-delay": async ({ itemId }) =>
				applyContinuationDelayChoice(
					runtime,
					ctx,
					options,
					settingsPath,
					itemId,
					isMenuCurrent,
				),
			"set-visibility": async ({ value }) => {
				const nextVisibility = value === "Always" ? "always" : "after-first-goal";
				if (nextVisibility === runtime.settings.toolVisibility) return { kind: "stay" };
				try {
					const next = {
						...structuredClone(runtime.settings),
						toolVisibility: nextVisibility,
					} satisfies GoalSettings;
					applyGoalSettings(runtime, next, ctx, {
						save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
					});
					notifyTerminal(ctx.ui, `Goal tools: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					notifySettingsFailure(ctx, settingsPath, error);
					return { kind: "rejected" };
				}
			},
			"set-queue": async ({ value }) => {
				const enabled = value === "Experimental";
				if (enabled === runtime.settings.experimental.goals) return { kind: "stay" };
				const next = await nextQueueSettings(runtime, ctx, enabled);
				if (!next) return { kind: "rejected" };
				const wasFrozen = runtime.queueFrozen;
				try {
					applyGoalSettings(runtime, next, ctx, {
						save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
					});
					if (wasFrozen && !runtime.queueFrozen) {
						try {
							await options.onQueueUnfrozen?.(ctx);
						} catch (error) {
							notifyTerminal(
								ctx.ui,
								`Goal queue enabled, but automatic resume failed: ${safeTerminalText(formatError(error))}. Reopen /goal to retry.`,
								"warning",
							);
						}
					}
					notifyTerminal(
						ctx.ui,
						`Ordered goal queue: ${enabled ? "Experimental" : "Off"}.`,
						"info",
					);
					return { kind: "stay" };
				} catch (error) {
					notifySettingsFailure(ctx, settingsPath, error);
					return { kind: "rejected" };
				}
			},
			"set-rpc": async ({ value }) => {
				const enabled = value === "On";
				if (enabled === runtime.settings.rpc.enabled) return { kind: "stay" };
				try {
					const next = {
						...structuredClone(runtime.settings),
						rpc: { enabled },
					} satisfies GoalSettings;
					applyGoalSettings(runtime, next, ctx, {
						save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
					});
					notifyTerminal(ctx.ui, `Managed run RPC: ${enabled ? "On" : "Off"}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					notifySettingsFailure(ctx, settingsPath, error);
					return { kind: "rejected" };
				}
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: runtime.menuController.signal,
		isCurrent: isMenuCurrent,
	});
}

function continuationDelayChoiceScreen(runtime: GoalRuntime) {
	const value = runtime.settings.continuationLimits.minIntervalMs;
	return {
		kind: "actions" as const,
		title: "Continuation delay",
		lines: [
			`Current: ${formatContinuationDelay(value)}`,
			"Wait this many whole milliseconds after an eligible settled boundary before dispatching.",
		],
		items: [
			{
				id: "off",
				label: "Off",
				description: "Dispatch immediately with a delay of 0 milliseconds.",
				action: "choose-continuation-delay" as const,
			},
			{
				id: "custom",
				label: "Set delay…",
				description: "Choose a non-negative safe whole number of milliseconds.",
				action: "choose-continuation-delay" as const,
			},
		],
		hint: "back" as const,
	};
}

function limitChoiceScreen(
	runtime: GoalRuntime,
	field: LimitField,
	action: "choose-automatic" | "choose-no-progress",
) {
	const value = runtime.settings.continuationLimits[field];
	const goal = runtime.activeGoal;
	return {
		kind: "actions" as const,
		title: field === "automaticTurns" ? "Automatic-work limit" : "No-progress guard",
		lines: [
			field === "automaticTurns"
				? `Current: ${formatAutomaticWork(value)}`
				: `Current: ${formatNoProgressProtection(value)}`,
			...(field === "automaticTurns"
				? [
						`Set a whole-number response limit for each automatic-work epoch. Default: ${DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns}.`,
					]
				: []),
			...(goal
				? [
						field === "automaticTurns"
							? `Active goal: ${goal.automaticModelTurns} automatic responses used`
							: `Active goal: ${goal.toolFreeRepeatCount} repeated or empty runs detected`,
					]
				: []),
		],
		items: limitChoices(field, value, goal?.automaticModelTurns).map((item) => ({
			id: item.value,
			label: item.label,
			description: item.description,
			action,
		})),
		hint: "back" as const,
	};
}

function limitChoices(
	field: LimitField,
	value: number | null,
	automaticTurnsUsed: number | undefined,
): Array<{ value: LimitSelection; label: string; description: string }> {
	if (field === "automaticTurns") {
		const unlimitedDescription =
			value === null
				? "No response-count cap. Completion, manual pause, blockers, provider limits, and other configured guards still apply."
				: automaticTurnsUsed === undefined
					? `Remove the current ${value}-response cap. Goal work will have no response-count cap; other configured stop conditions remain.`
					: `Remove the current ${value}-response cap. The active goal has used ${automaticTurnsUsed} responses; other configured stop conditions remain.`;
		return [
			{
				value: "custom",
				label: "Set response limit…",
				description: `Choose a whole-number response limit for each automatic-work epoch. Default: ${DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns}.`,
			},
			{ value: "unlimited", label: "Unlimited…", description: unlimitedDescription },
		];
	}
	const defaultLimit = DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns;
	return [
		{
			value: "default",
			label: `After ${defaultLimit} repeated runs (default)`,
			description: "Pause after the default number of repeated or empty tool-free runs.",
		},
		{
			value: "custom",
			label: "Set threshold…",
			description: "Choose a whole number of repeated or empty runs before pausing.",
		},
		{
			value: "off",
			label: "Off",
			description: "Do not pause based on repeated or empty tool-free runs.",
		},
	];
}

async function applyLimitChoice(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions,
	settingsPath: string,
	field: LimitField,
	itemId: string,
	activeGoalId: string | null,
	isCurrent: () => boolean,
) {
	if (!isCurrent() || !isLimitSelection(itemId)) return { kind: "rejected" as const };
	if ((runtime.activeGoal?.id ?? null) !== activeGoalId) {
		notifyTerminal(
			ctx.ui,
			"The active goal changed while the safety setting was open. No settings were changed.",
			"warning",
		);
		return { kind: "rejected" as const };
	}
	const previous = runtime.settings.continuationLimits[field];
	const limit = await resolveLimitSelection(field, itemId, previous, ctx, isCurrent);
	if (!isCurrent()) return { kind: "rejected" as const };
	if (limit === undefined || limit === previous) return { kind: "back" as const };
	if ((runtime.activeGoal?.id ?? null) !== activeGoalId) {
		notifyTerminal(
			ctx.ui,
			"The active goal changed while editing the safety setting. No settings were changed.",
			"warning",
		);
		return { kind: "rejected" as const };
	}
	const confirmation = await confirmLowerActiveLimit(runtime, ctx, field, limit);
	if (!isCurrent() || !confirmation.apply) return { kind: "rejected" as const };
	if (confirmation.goalId !== undefined && runtime.activeGoal?.id !== confirmation.goalId) {
		notifyTerminal(
			ctx.ui,
			"The active goal changed while confirming the limit. No settings were changed.",
			"warning",
		);
		return { kind: "rejected" as const };
	}
	try {
		applyGoalSettings(runtime, withLimit(runtime.settings, field, limit), ctx, {
			save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
		});
		notifyTerminal(ctx.ui, formatLimitSuccess(field, limit), "info");
		return { kind: "back" as const };
	} catch (error) {
		notifySettingsFailure(ctx, settingsPath, error);
		return { kind: "rejected" as const };
	}
}

export function applyGoalSettings(
	runtime: GoalRuntime,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
	options: GoalSettingsApplyOptions = {},
) {
	const snapshot = runtime.snapshotSettingsApplicationState();
	let fileSaved = false;
	try {
		runtime.settings = structuredClone(next);
		applyToolVisibility(runtime, snapshot.settings, next, ctx);
		options.save?.(next);
		fileSaved = options.save !== undefined;
		applyQueueSetting(runtime, ctx);
		const activeGoalId = runtime.activeGoal?.id;
		const abortOwnedRun = activeGoalId !== undefined && runtime.agentRunGoalId === activeGoalId;
		const pausedByAutomaticLimit = runtime.enforceAutomaticTurnLimit(ctx, abortOwnedRun);
		if (!pausedByAutomaticLimit) runtime.enforceNoProgressLimit(ctx, abortOwnedRun);
		if (runtime.activeGoal && !runtime.queueFrozen) {
			runtime.updateStatus(ctx, runtime.activeGoal);
		}
		if (
			snapshot.settings.continuationLimits.minIntervalMs !==
			next.continuationLimits.minIntervalMs
		) {
			runtime.reconcileContinuationDispatchTimer(ctx);
		}
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		try {
			runtime.restoreSettingsApplicationState(snapshot);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (fileSaved) {
			try {
				options.save?.(snapshot.settings);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			try {
				restorePersistedRuntime(runtime, ctx);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				`pi-goal settings application failed and rollback was incomplete: ${formatError(error)}`,
			);
		}
		throw error;
	}
}

export function parseContinuationDelay(value: string): number | undefined {
	const normalized = value.trim();
	if (!/^\d+$/u.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseGoalLimit(value: string): number | undefined {
	const normalized = value.trim();
	if (!/^\d+$/u.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatGoalLimit(value: number | null) {
	return value === null ? "Unlimited" : String(value);
}

async function resolveLimitSelection(
	field: LimitField,
	selection: LimitSelection,
	previous: number | null,
	ctx: ExtensionCommandContext,
	isCurrent: () => boolean,
): Promise<number | null | undefined> {
	if (selection === "off") return null;
	if (selection === "unlimited") {
		if (previous === null) return null;
		const confirmed = await ctx.ui.confirm(
			"Allow Unlimited automatic work?",
			"Tool loops can continue without a response-count limit and may consume substantial tokens and provider cost. Completion, manual pause, blockers, provider limits, and the no-progress guard still apply.",
		);
		return isCurrent() && confirmed ? null : undefined;
	}
	if (selection === "default") {
		return DEFAULT_GOAL_SETTINGS.continuationLimits[field];
	}
	while (true) {
		const raw =
			field === "automaticTurns"
				? await ctx.ui.editor(
						`Automatic-work response limit (whole number greater than 0) · Default: ${DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns}`,
						String(previous ?? DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns),
					)
				: await ctx.ui.input(
						"Repeated-run threshold (whole number greater than 0)",
						previous === null ? "Positive whole number" : String(previous),
					);
		if (!isCurrent() || raw === undefined) return undefined;
		const parsed = parseGoalLimit(raw);
		if (parsed !== undefined) return parsed;
		notifyTerminal(
			ctx.ui,
			`Enter a whole number greater than 0. Choose ${field === "automaticTurns" ? "Unlimited" : "Off"} from the previous screen if you do not want a limit.`,
			"warning",
		);
	}
}

async function applyContinuationDelayChoice(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions,
	settingsPath: string,
	itemId: string,
	isCurrent: () => boolean,
) {
	if (!isCurrent() || !isDelaySelection(itemId)) return { kind: "rejected" as const };
	let delay = 0;
	if (itemId === "custom") {
		while (true) {
			const raw = await ctx.ui.input(
				"Continuation delay (whole milliseconds, 0 or greater)",
				String(runtime.settings.continuationLimits.minIntervalMs),
			);
			if (!isCurrent() || raw === undefined) return { kind: "rejected" as const };
			const parsed = parseContinuationDelay(raw);
			if (parsed !== undefined) {
				delay = parsed;
				break;
			}
			notifyTerminal(ctx.ui, "Enter a whole number of milliseconds, 0 or greater.", "warning");
		}
	}
	if (delay === runtime.settings.continuationLimits.minIntervalMs) {
		return { kind: "back" as const };
	}
	try {
		const next = {
			...structuredClone(runtime.settings),
			continuationLimits: {
				...runtime.settings.continuationLimits,
				minIntervalMs: delay,
			},
		} satisfies GoalSettings;
		applyGoalSettings(runtime, next, ctx, {
			save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
		});
		notifyTerminal(ctx.ui, `Continuation delay: ${formatContinuationDelay(delay)}.`, "info");
		return { kind: "back" as const };
	} catch (error) {
		notifySettingsFailure(ctx, settingsPath, error);
		return { kind: "rejected" as const };
	}
}

async function nextQueueSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	enabled: boolean,
) {
	if (runtime.settings.experimental.goals === enabled) return undefined;
	if (enabled && !runtime.settings.experimental.goals) {
		const confirmed = await ctx.ui.confirm(
			"Enable experimental goal queue?",
			"Queue behavior and persisted state may change between releases. Existing single-goal behavior remains available.",
		);
		if (!confirmed) return undefined;
	}
	if (
		!enabled &&
		(runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined) &&
		!(await ctx.ui.confirm(
			"Freeze ordered goal queue?",
			`Disabling the experiment preserves ${retainedGoalCount(runtime)} goal(s) but freezes automatic work until the setting is re-enabled. No goal data will be deleted.`,
		))
	) {
		return undefined;
	}
	return {
		...structuredClone(runtime.settings),
		experimental: { goals: enabled },
	} satisfies GoalSettings;
}

function applyToolVisibility(
	runtime: GoalRuntime,
	previous: GoalSettings,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
) {
	runtime.toolPolicy.applyVisibilityChange(
		previous.toolVisibility,
		next.toolVisibility,
		runtime.activeGoal !== undefined,
		ctx,
	);
}

function applyQueueSetting(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	const hasQueueState = runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined;
	const shouldFreeze = !runtime.settings.experimental.goals && hasQueueState;
	// Keep the freeze guard until the aborted Goal-owned run reaches agent_settled.
	// Releasing it earlier lets the old agent_end pause newly resumed work.
	if (runtime.queueFrozen && !shouldFreeze && runtime.queueFreezeAwaitingSettle) return;
	if (runtime.queueFrozen === shouldFreeze) return;
	const activeGoal = runtime.activeGoal?.status === "active" ? runtime.activeGoal : undefined;
	const goalOwnedRun = activeGoal && runtime.agentRunGoalId === activeGoal.id;
	if (shouldFreeze && activeGoal) {
		if (goalOwnedRun) runtime.recordGoalUsage(activeGoal, ctx, false);
		else {
			const now = Date.now();
			checkpointGoalActiveTime(activeGoal, now, false);
			activeGoal.updatedAt = now;
		}
	}
	runtime.queueFrozen = shouldFreeze;
	if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
	if (shouldFreeze) ctx.ui.setStatus(STATUS_KEY, "queue off");
	else if (runtime.activeGoal) runtime.updateStatus(ctx, runtime.activeGoal);
	else ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!shouldFreeze) return;

	runtime.clearGoalWaitTimer();
	runtime.cancelContinuationWork();
	runtime.clearGoalRecovery();
	runtime.clearBudgetWrapUp();
	if (goalOwnedRun) {
		runtime.blockStaleGoalToolCalls();
		runtime.guardAbortGoalId = activeGoal.id;
		runtime.queueFreezeAwaitingSettle = true;
		runtime.clearAgentRun();
		abortCurrentTurn(ctx);
	}
}

function restorePersistedRuntime(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	if (runtime.activeGoal) {
		runtime.persistGoal(runtime.activeGoal);
		if (runtime.queueFrozen) ctx.ui.setStatus(STATUS_KEY, "queue off");
		else runtime.updateStatus(ctx, runtime.activeGoal);
		runtime.restoreGoalWaitTimer(ctx);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function confirmLowerActiveLimit(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	field: LimitField,
	limit: number | null,
) {
	const goal = runtime.activeGoal;
	if (goal?.status !== "active" || limit === null) return { apply: true };
	const used = field === "automaticTurns" ? goal.automaticModelTurns : goal.toolFreeRepeatCount;
	if (used < limit) return { apply: true };
	return {
		apply: await ctx.ui.confirm(
			"Apply limit and pause now?",
			`The active goal has already used ${used}. Setting this limit to ${limit} will pause it immediately without deleting progress.`,
		),
		goalId: goal.id,
	};
}

function withLimit(settings: GoalSettings, field: LimitField, value: number | null): GoalSettings {
	return {
		...structuredClone(settings),
		continuationLimits: { ...settings.continuationLimits, [field]: value },
	};
}

function formatContinuationDelay(value: number) {
	return value === 0 ? "Off" : `${value} ms`;
}

function formatAutomaticSettingValue(value: number | null) {
	return value === null ? "Unlimited" : `${value} responses`;
}

function formatNoProgressSettingValue(value: number | null) {
	if (value === null) return "Off";
	return `${value} ${value === 1 ? "run" : "runs"}`;
}

function formatAutomaticWork(value: number | null) {
	return value === null ? "Unlimited" : `Up to ${value} responses`;
}

function formatNoProgressProtection(value: number | null) {
	if (value === null) return "Off";
	return `After ${value} repeated ${value === 1 ? "run" : "runs"}`;
}

function formatLimitSuccess(field: LimitField, value: number | null) {
	return field === "automaticTurns"
		? `Automatic-work limit: ${formatAutomaticWork(value)}.`
		: `No-progress guard: ${formatNoProgressProtection(value)}.`;
}

function isLimitSelection(value: string): value is LimitSelection {
	return value === "unlimited" || value === "default" || value === "custom" || value === "off";
}

function isDelaySelection(value: string): value is DelaySelection {
	return value === "custom" || value === "off";
}

function visibilityLabel(value: GoalSettings["toolVisibility"]) {
	return value === "always" ? "Always" : "After first goal";
}

function retainedGoalCount(runtime: GoalRuntime) {
	return (
		(runtime.activeGoal ? 1 : 0) +
		runtime.queuedGoals.length +
		(runtime.pendingQueueAction?.kind === "prioritize" ? 1 : 0)
	);
}

function notifySettingsFailure(ctx: ExtensionCommandContext, settingsPath: string, error: unknown) {
	const path = safeTerminalText(settingsPath);
	const detail = safeTerminalText(formatError(error));
	notifyTerminal(
		ctx.ui,
		error instanceof AggregateError
			? `Could not apply Goal settings, and rollback was incomplete. Check ${path}, run /reload, and verify the effective settings before retrying: ${detail}`
			: `Could not save Goal settings; the previous value remains. Check ${path} and retry: ${detail}`,
		"error",
	);
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
