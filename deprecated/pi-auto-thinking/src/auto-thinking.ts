import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;

type Config = {
	enabled: boolean;
	minLevel: ThinkingLevel;
	maxLevel: ThinkingLevel;
	respectManualTurns: number;
	modelOverrides: Record<string, ModelOverride>;
};

type ModelOverride = {
	enabled?: boolean;
	minLevel?: ThinkingLevel;
	maxLevel?: ThinkingLevel;
};

type LoadedConfig = {
	config: Config;
	path: string;
	warnings: string[];
};

type ScoreSignal = {
	label: string;
	weight: number;
};

type PromptScore = {
	score: number;
	baseLevel: ThinkingLevel;
	signals: ScoreSignal[];
};

type ThinkingDecision = {
	kind: "selected";
	level: ThinkingLevel;
	baseLevel: ThinkingLevel;
	score: number;
	reasons: string[];
	modelKey?: string;
};

type SkippedDecision = {
	kind: "skipped";
	reason: string;
	reasons: string[];
};

type LastDecision = ThinkingDecision | SkippedDecision;

type RuntimeState = {
	config: Config;
	configPath: string;
	configWarnings: string[];
	enabled: boolean;
	lastDecision?: LastDecision;
	manualSuppressionTurnsRemaining: number;
	pendingManualSuppression: boolean;
	expectedThinkingLevel?: ThinkingLevel;
};

const STATUS_KEY = "auto-thinking";
const COMMAND_NAME = "auto-thinking";
const CONFIG_FILE_NAME = "pi-auto-thinking.json";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];
const MAX_RESPECT_MANUAL_TURNS = 20;

const DEFAULT_CONFIG: Config = {
	enabled: true,
	minLevel: "minimal",
	maxLevel: "high",
	respectManualTurns: 3,
	modelOverrides: {},
};

const RULES: Array<{
	label: string;
	weight: number;
	patterns: RegExp[];
}> = [
	{
		label: "quick or brief response requested",
		weight: -2,
		patterns: [
			/\b(quick|brief|short|concise|fast|simple|tl;dr)\b/i,
			/(快速|簡短|簡潔|簡單|摘要|不用詳細)/,
		],
	},
	{
		label: "simple explanation or translation",
		weight: -1,
		patterns: [
			/\b(explain|translate|summari[sz]e|what is|how do i)\b/i,
			/(解釋|翻譯|說明|什麼是|怎麼)/,
		],
	},
	{
		label: "implementation or editing task",
		weight: 2,
		patterns: [
			/\b(implement|add|update|change|modify|fix|create|write|build)\b/i,
			/(實作|新增|更新|修改|修正|建立|撰寫|完成)/,
		],
	},
	{
		label: "debugging or failure investigation",
		weight: 2,
		patterns: [
			/\b(bug|debug|error|exception|stack trace|traceback|failing|fails|failure|broken)\b/i,
			/(錯誤|除錯|失敗|例外|堆疊|壞掉|修 bug)/i,
		],
	},
	{
		label: "tests, lint, or typechecking mentioned",
		weight: 1,
		patterns: [
			/\b(test|tests|testing|lint|typecheck|typescript|tsc|biome|ruff|pytest|ci)\b/i,
			/(測試|型別|檢查|CI|lint)/i,
		],
	},
	{
		label: "design, architecture, or planning task",
		weight: 3,
		patterns: [
			/\b(design|architecture|architect|plan|roadmap|proposal|trade-?off|review the plan)\b/i,
			/(設計|架構|計畫|規劃|取捨|方案|審查計畫)/,
		],
	},
	{
		label: "migration, refactor, or compatibility work",
		weight: 3,
		patterns: [
			/\b(migrat(e|ion)|refactor|restructure|compatibility|backwards compatible|breaking change)\b/i,
			/(遷移|重構|相容|破壞性變更)/,
		],
	},
	{
		label: "security, concurrency, or data-risk topic",
		weight: 3,
		patterns: [
			/\b(security|permission|auth|token|secret|credential|race|concurrency|transaction|data loss|rollback|recovery)\b/i,
			/(安全|權限|認證|密鑰|憑證|併發|交易|資料遺失|回復|復原)/,
		],
	},
	{
		label: "deep reasoning explicitly requested",
		weight: 3,
		patterns: [
			/\b(think hard|think deeply|deep dive|carefully|thorough|comprehensive|ultrathink)\b/i,
			/(仔細|深入|完整|全面|深度思考|認真想)/,
		],
	},
];

export default function autoThinking(pi: ExtensionAPI) {
	const loaded = loadConfig();
	const runtime: RuntimeState = {
		config: loaded.config,
		configPath: loaded.path,
		configWarnings: loaded.warnings,
		enabled: loaded.config.enabled,
		manualSuppressionTurnsRemaining: 0,
		pendingManualSuppression: false,
	};

	pi.on("session_start", (_event, ctx) => {
		const next = loadConfig();
		runtime.config = next.config;
		runtime.configPath = next.path;
		runtime.configWarnings = next.warnings;
		runtime.enabled = next.config.enabled;
		runtime.manualSuppressionTurnsRemaining = 0;
		runtime.pendingManualSuppression = false;
		runtime.expectedThinkingLevel = undefined;
		runtime.lastDecision = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		for (const warning of next.warnings) ctx.ui.notify(warning, "warning");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!runtime.enabled) {
			const decision = skippedDecision("Auto thinking is disabled.");
			runtime.lastDecision = decision;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		if (runtime.manualSuppressionTurnsRemaining > 0) {
			runtime.pendingManualSuppression = false;
			const skippedTurns = runtime.manualSuppressionTurnsRemaining;
			runtime.manualSuppressionTurnsRemaining -= 1;
			const decision = skippedDecision(
				`Manual thinking change detected; automation paused for ${skippedTurns} more turn${skippedTurns === 1 ? "" : "s"}.`,
			);
			runtime.lastDecision = decision;
			ctx.ui.setStatus(
				STATUS_KEY,
				`auto-thinking paused ${runtime.manualSuppressionTurnsRemaining}`,
			);
			return;
		}

		const decision = decideThinkingLevel({
			config: runtime.config,
			hasImages: (event.images?.length ?? 0) > 0,
			model: ctx.model,
			prompt: event.prompt,
		});
		runtime.lastDecision = decision;

		const currentLevel = pi.getThinkingLevel();
		if (currentLevel !== decision.level) {
			runtime.expectedThinkingLevel = decision.level;
			pi.setThinkingLevel(decision.level);
			setTimeout(() => {
				if (runtime.expectedThinkingLevel === decision.level) {
					runtime.expectedThinkingLevel = undefined;
				}
			}, 0).unref?.();
		}

		ctx.ui.setStatus(STATUS_KEY, formatStatus(decision));
	});

	pi.on("thinking_level_select", (event, ctx) => {
		if (runtime.expectedThinkingLevel === event.level) {
			runtime.expectedThinkingLevel = undefined;
			return;
		}

		if (!runtime.enabled || runtime.config.respectManualTurns <= 0) return;

		runtime.manualSuppressionTurnsRemaining = runtime.config.respectManualTurns;
		runtime.pendingManualSuppression = true;
		runtime.lastDecision = skippedDecision(
			`Thinking level changed outside auto-thinking (${event.previousLevel} -> ${event.level}); automation will pause for ${runtime.manualSuppressionTurnsRemaining} turn${runtime.manualSuppressionTurnsRemaining === 1 ? "" : "s"}.`,
		);
		ctx.ui.setStatus(STATUS_KEY, `auto-thinking paused ${runtime.manualSuppressionTurnsRemaining}`);
	});

	pi.on("model_select", (_event, ctx) => {
		if (runtime.pendingManualSuppression) {
			runtime.manualSuppressionTurnsRemaining = 0;
			runtime.pendingManualSuppression = false;
			runtime.lastDecision = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		if (!runtime.enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (runtime.lastDecision) ctx.ui.setStatus(STATUS_KEY, formatLastDecision(runtime.lastDecision));
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Configure automatic thinking level selection",
		handler: async (args, ctx) => {
			handleCommand(args, runtime, ctx);
		},
	});
}

function loadConfig(): LoadedConfig {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) return { config: { ...DEFAULT_CONFIG }, path: configPath, warnings: [] };

	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const warnings: string[] = [];
		const config = parseConfig(parsed, warnings);
		return { config, path: configPath, warnings };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			config: { ...DEFAULT_CONFIG },
			path: configPath,
			warnings: [
				`Failed to load ${CONFIG_FILE_NAME}; using defaults. ${message}`,
			],
		};
	}
}

function getConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
	return join(agentDir, CONFIG_FILE_NAME);
}

function parseConfig(value: unknown, warnings: string[]): Config {
	if (!isRecord(value)) {
		warnings.push(`${CONFIG_FILE_NAME} must contain a JSON object; using defaults.`);
		return { ...DEFAULT_CONFIG };
	}

	return {
		enabled: readBoolean(value.enabled, DEFAULT_CONFIG.enabled, "enabled", warnings),
		minLevel: readThinkingLevel(value.minLevel, DEFAULT_CONFIG.minLevel, "minLevel", warnings),
		maxLevel: readThinkingLevel(value.maxLevel, DEFAULT_CONFIG.maxLevel, "maxLevel", warnings),
		respectManualTurns: readInteger(
			value.respectManualTurns,
			DEFAULT_CONFIG.respectManualTurns,
			"respectManualTurns",
			warnings,
		),
		modelOverrides: readModelOverrides(value.modelOverrides, warnings),
	};
}

function readModelOverrides(value: unknown, warnings: string[]): Record<string, ModelOverride> {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		warnings.push("modelOverrides must be an object; ignoring it.");
		return {};
	}

	const overrides: Record<string, ModelOverride> = {};
	for (const [modelKey, overrideValue] of Object.entries(value)) {
		if (!isRecord(overrideValue)) {
			warnings.push(`modelOverrides.${modelKey} must be an object; ignoring it.`);
			continue;
		}
		const override: ModelOverride = {};
		if (overrideValue.enabled !== undefined) {
			override.enabled = readBoolean(
				overrideValue.enabled,
				DEFAULT_CONFIG.enabled,
				`modelOverrides.${modelKey}.enabled`,
				warnings,
			);
		}
		if (overrideValue.minLevel !== undefined) {
			override.minLevel = readThinkingLevel(
				overrideValue.minLevel,
				DEFAULT_CONFIG.minLevel,
				`modelOverrides.${modelKey}.minLevel`,
				warnings,
			);
		}
		if (overrideValue.maxLevel !== undefined) {
			override.maxLevel = readThinkingLevel(
				overrideValue.maxLevel,
				DEFAULT_CONFIG.maxLevel,
				`modelOverrides.${modelKey}.maxLevel`,
				warnings,
			);
		}
		overrides[modelKey] = override;
	}
	return overrides;
}

function readBoolean(value: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`${field} must be a boolean; using ${fallback}.`);
	return fallback;
}

function readInteger(value: unknown, fallback: number, field: string, warnings: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		warnings.push(`${field} must be an integer; using ${fallback}.`);
		return fallback;
	}
	if (value < 0 || value > MAX_RESPECT_MANUAL_TURNS) {
		warnings.push(`${field} must be between 0 and ${MAX_RESPECT_MANUAL_TURNS}; using ${fallback}.`);
		return fallback;
	}
	return value;
}

function readThinkingLevel(
	value: unknown,
	fallback: ThinkingLevel,
	field: string,
	warnings: string[],
): ThinkingLevel {
	if (value === undefined) return fallback;
	if (typeof value === "string" && isThinkingLevel(value)) return value;
	warnings.push(`${field} must be one of ${LEVELS.join(", ")}; using ${fallback}.`);
	return fallback;
}

function decideThinkingLevel(input: {
	config: Config;
	hasImages: boolean;
	model: ExtensionContext["model"];
	prompt: string;
}): ThinkingDecision {
	const modelKey = input.model ? getModelKey(input.model) : undefined;
	const override = modelKey ? input.config.modelOverrides[modelKey] : undefined;
	const enabled = override?.enabled ?? input.config.enabled;
	if (!enabled) {
		return {
			kind: "selected",
			level: "off",
			baseLevel: "off",
			score: 0,
			reasons: [`Automation disabled for ${modelKey ?? "current model"}.`],
			modelKey,
		};
	}

	const minLevel = override?.minLevel ?? input.config.minLevel;
	const maxLevel = override?.maxLevel ?? input.config.maxLevel;
	const promptScore = scorePrompt(input.prompt, input.hasImages);
	const boundedLevel = clampLevel(promptScore.baseLevel, minLevel, maxLevel);
	const level = selectSupportedLevel(input.model, boundedLevel, minLevel, maxLevel);
	const reasons = buildDecisionReasons({
		boundedLevel,
		level,
		maxLevel,
		minLevel,
		model: input.model,
		modelKey,
		promptScore,
	});

	return {
		kind: "selected",
		level,
		baseLevel: promptScore.baseLevel,
		score: promptScore.score,
		reasons,
		modelKey,
	};
}

function scorePrompt(prompt: string, hasImages: boolean): PromptScore {
	const signals: ScoreSignal[] = [];
	const normalizedPrompt = prompt.trim();

	for (const rule of RULES) {
		if (rule.patterns.some((pattern) => pattern.test(normalizedPrompt))) {
			signals.push({ label: rule.label, weight: rule.weight });
		}
	}

	const codeBlockCount = countMatches(normalizedPrompt, /```/g) / 2;
	if (codeBlockCount >= 1) signals.push({ label: "code block included", weight: 1 });

	const filePathCount = countFilePaths(normalizedPrompt);
	if (filePathCount >= 3) signals.push({ label: "multiple file paths mentioned", weight: 2 });
	else if (filePathCount >= 1) signals.push({ label: "file path mentioned", weight: 1 });

	const longPromptWords = normalizedPrompt.split(/\s+/).filter(Boolean).length;
	if (longPromptWords >= 180) signals.push({ label: "long prompt", weight: 1 });

	if (hasImages) signals.push({ label: "image input attached", weight: 1 });

	const score = signals.reduce((total, signal) => total + signal.weight, 0);
	return { score, baseLevel: levelForScore(score), signals };
}

function levelForScore(score: number): ThinkingLevel {
	if (score <= 0) return "minimal";
	if (score <= 2) return "low";
	if (score <= 5) return "medium";
	if (score <= 8) return "high";
	return "xhigh";
}

function selectSupportedLevel(
	model: ExtensionContext["model"],
	candidate: ThinkingLevel,
	minLevel: ThinkingLevel,
	maxLevel: ThinkingLevel,
): ThinkingLevel {
	if (!model) return "off";
	if (!model.reasoning) return "off";

	const supported = LEVELS.filter((level) => isModelLevelSupported(model, level));
	const boundedSupported = supported.filter(
		(level) => compareLevels(level, minLevel) >= 0 && compareLevels(level, maxLevel) <= 0,
	);
	const candidates = boundedSupported.length > 0 ? boundedSupported : supported;
	if (candidates.length === 0) return "off";
	if (candidates.includes(candidate)) return candidate;

	const lowerOrEqual = candidates
		.filter((level) => compareLevels(level, candidate) <= 0)
		.sort((a, b) => compareLevels(b, a));
	if (lowerOrEqual[0]) return lowerOrEqual[0];

	return [...candidates].sort(compareLevels)[0] ?? "off";
}

function isModelLevelSupported(model: Model, level: ThinkingLevel): boolean {
	if (!model.reasoning) return level === "off";
	return model.thinkingLevelMap?.[level] !== null;
}

function clampLevel(level: ThinkingLevel, minLevel: ThinkingLevel, maxLevel: ThinkingLevel): ThinkingLevel {
	const low = Math.min(levelIndex(minLevel), levelIndex(maxLevel));
	const high = Math.max(levelIndex(minLevel), levelIndex(maxLevel));
	return LEVELS[Math.min(Math.max(levelIndex(level), low), high)];
}

function compareLevels(a: ThinkingLevel, b: ThinkingLevel): number {
	return levelIndex(a) - levelIndex(b);
}

function levelIndex(level: ThinkingLevel): number {
	return LEVELS.indexOf(level);
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return LEVELS.includes(value as ThinkingLevel);
}

function getModelKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function buildDecisionReasons(input: {
	boundedLevel: ThinkingLevel;
	level: ThinkingLevel;
	maxLevel: ThinkingLevel;
	minLevel: ThinkingLevel;
	model: ExtensionContext["model"];
	modelKey?: string;
	promptScore: PromptScore;
}): string[] {
	const reasons: string[] = [];
	if (!input.model) {
		reasons.push("No active model is available, so auto-thinking selected off.");
		return reasons;
	}

	reasons.push(`Model: ${input.modelKey}.`);
	if (!input.model.reasoning) {
		reasons.push("The active model does not advertise reasoning support, so thinking is off.");
		return reasons;
	}

	reasons.push(`Task score ${input.promptScore.score} mapped to ${input.promptScore.baseLevel}.`);
	for (const signal of input.promptScore.signals) {
		const sign = signal.weight > 0 ? "+" : "";
		reasons.push(`${sign}${signal.weight}: ${signal.label}.`);
	}
	if (input.promptScore.signals.length === 0) reasons.push("No complexity signals matched.");

	if (input.boundedLevel !== input.promptScore.baseLevel) {
		reasons.push(
			`Config bounds ${input.minLevel}..${input.maxLevel} changed ${input.promptScore.baseLevel} to ${input.boundedLevel}.`,
		);
	} else {
		reasons.push(`Config bounds ${input.minLevel}..${input.maxLevel} kept ${input.boundedLevel}.`);
	}

	if (input.level !== input.boundedLevel) {
		reasons.push(`Model thinkingLevelMap changed ${input.boundedLevel} to ${input.level}.`);
	}

	return reasons;
}

function skippedDecision(reason: string): SkippedDecision {
	return { kind: "skipped", reason, reasons: [reason] };
}

function handleCommand(args: string, runtime: RuntimeState, ctx: ExtensionCommandContext): void {
	const command = args.trim().toLowerCase();
	switch (command || "status") {
		case "on":
			runtime.enabled = true;
			runtime.manualSuppressionTurnsRemaining = 0;
			runtime.pendingManualSuppression = false;
			ctx.ui.notify("Auto thinking enabled.", "info");
			return;
		case "off":
			runtime.enabled = false;
			runtime.manualSuppressionTurnsRemaining = 0;
			runtime.pendingManualSuppression = false;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify("Auto thinking disabled.", "info");
			return;
		case "status":
			ctx.ui.notify(formatRuntimeStatus(runtime), "info");
			return;
		case "explain":
			ctx.ui.notify(formatExplanation(runtime.lastDecision), "info");
			return;
		case "help":
			ctx.ui.notify(formatHelp(), "info");
			return;
		default:
			ctx.ui.notify(`Unknown /${COMMAND_NAME} command: ${args.trim()}\n\n${formatHelp()}`, "warning");
	}
}

function formatRuntimeStatus(runtime: RuntimeState): string {
	return [
		`Auto thinking: ${runtime.enabled ? "on" : "off"}`,
		`Config: ${runtime.configPath}`,
		`Bounds: ${runtime.config.minLevel}..${runtime.config.maxLevel}`,
		`Respect manual turns: ${runtime.config.respectManualTurns}`,
		`Manual suppression remaining: ${runtime.manualSuppressionTurnsRemaining}`,
		runtime.configWarnings.length > 0
			? `Config warnings:\n${runtime.configWarnings.map((warning) => `- ${warning}`).join("\n")}`
			: "Config warnings: none",
	].join("\n");
}

function formatExplanation(decision: LastDecision | undefined): string {
	if (!decision) return "No auto-thinking decision has been made yet.";
	if (decision.kind === "skipped") return decision.reasons.join("\n");
	return [
		`Selected: ${decision.level}`,
		`Base level: ${decision.baseLevel}`,
		`Score: ${decision.score}`,
		...decision.reasons,
	].join("\n");
}

function formatHelp(): string {
	return [
		`/${COMMAND_NAME} status - show current auto-thinking state`,
		`/${COMMAND_NAME} on - enable automatic thinking selection`,
		`/${COMMAND_NAME} off - disable automatic thinking selection`,
		`/${COMMAND_NAME} explain - explain the last decision`,
	].join("\n");
}

function formatStatus(decision: ThinkingDecision): string {
	if (decision.level === "off") return "auto-thinking off";
	return `auto-thinking ${decision.level}`;
}

function formatLastDecision(decision: LastDecision): string | undefined {
	if (decision.kind === "selected") return formatStatus(decision);
	return decision.reason.includes("disabled") ? undefined : "auto-thinking paused";
}

function countMatches(value: string, pattern: RegExp): number {
	return [...value.matchAll(pattern)].length;
}

function countFilePaths(value: string): number {
	const pathMatches = value.match(
		/(?:^|[\s"'`(])(?:\.?\.?\/|~\/)?(?:[\w.-]+\/)+[\w.-]+(?:\.[\w-]+)?/g,
	);
	const filenameMatches = value.match(
		/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|rs|go|java|kt|swift|sh|yml|yaml|toml)\b/g,
	);
	return new Set([...(pathMatches ?? []), ...(filenameMatches ?? [])]).size;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
