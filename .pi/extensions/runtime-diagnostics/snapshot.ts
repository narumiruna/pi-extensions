import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticText } from "./text.js";

export const RUNTIME_ENTRY_TYPE = "pi-debug:runtime-snapshot";
const MAX_TOOL_NAMES = 200;
const MAX_EXTENSION_SURFACES = 100;
const MAX_CACHE_SAMPLES = 20;
const MAX_RUNTIME_RECORDS = 20;

const RUNTIME_SNAPSHOT_REASONS = [
	"session_start",
	"session_tree",
	"model_select",
	"before_agent_start",
	"tools_changed",
	"assistant_message",
	"diagnostic_tool",
] as const;

export type RuntimeSnapshotReason = (typeof RUNTIME_SNAPSHOT_REASONS)[number];

interface UsageLike {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ResponseCacheSample {
	capturedAt: number;
	provider: string | null;
	model: string | null;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokens: number;
	hitRatePercent: number | null;
}

export interface RuntimeSnapshot {
	version: 1;
	capturedAt: number;
	reason: RuntimeSnapshotReason;
	sessionId: string;
	provider: string | null;
	model: string | null;
	thinkingLevel: string;
	cache: ResponseCacheSample | null;
	tools: ToolState;
}

export interface ToolState {
	configuredCount: number;
	activeCount: number;
	inactiveCount: number;
	active: string[];
	inactive: string[];
	unknownActive: string[];
	omittedCount: number;
}

export interface ToolCatalogEntry {
	name: string;
	active: boolean;
	inactiveReason: string | null;
	knownProviderDefinitionBytes: number | null;
	source: {
		path: string;
		source: string;
		scope: string;
		origin: string;
	};
}

export interface ExtensionSurface {
	path: string;
	source: string;
	scope: string;
	origin: string;
	version: string | null;
	tools: string[];
	commands: string[];
}

export interface RuntimeDiagnosticReport {
	capturedAt: number;
	sessionId: string;
	current: {
		provider: string | null;
		model: string | null;
		thinkingLevel: string;
	};
	environment: {
		piCodingAgentVersion: string | null;
		nodeVersion: string;
		platform: string;
		architecture: string;
	};
	cache: {
		requestCount: number;
		input: number;
		cacheRead: number;
		cacheWrite: number;
		promptTokens: number;
		hitRatePercent: number | null;
		latest: ResponseCacheSample | null;
		recent: ResponseCacheSample[];
	};
	tools: ToolState;
	toolCatalog: ToolCatalogEntry[];
	extensions: {
		visibility: string;
		visibleCount: number;
		omittedCount: number;
		surfaces: ExtensionSurface[];
	};
	issues: string[];
	recentRuntimeRecords: RuntimeSnapshot[];
}

interface ResponseIdentity {
	provider?: string;
	model?: string;
	usage: UsageLike;
}

export function createRuntimeSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: RuntimeSnapshotReason,
	capturedAt: number,
	response?: ResponseIdentity,
): RuntimeSnapshot {
	return {
		version: 1,
		capturedAt,
		reason,
		sessionId: sanitizeDiagnosticText(ctx.sessionManager.getSessionId(), 128),
		provider: ctx.model?.provider ? sanitizeDiagnosticText(ctx.model.provider, 128) : null,
		model: ctx.model?.id ? sanitizeDiagnosticText(ctx.model.id, 256) : null,
		thinkingLevel: sanitizeDiagnosticText(pi.getThinkingLevel(), 32),
		cache: response
			? createCacheSample(response.usage, capturedAt, response.provider, response.model)
			: null,
		tools: collectToolState(pi),
	};
}

export function runtimeStateSignature(snapshot: RuntimeSnapshot): string {
	return JSON.stringify({
		provider: snapshot.provider,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		tools: snapshot.tools,
	});
}

export function createRuntimeReport(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	capturedAt: number,
): RuntimeDiagnosticReport {
	const entries = ctx.sessionManager.getBranch();
	const tools = collectToolState(pi);
	const toolCatalog = collectToolCatalog(pi);
	const extensions = collectExtensionSurfaces(pi);
	const issues: string[] = [];
	if (!ctx.model) issues.push("No active model is available in the extension context.");
	if (tools.unknownActive.length > 0) {
		issues.push(
			`Active tools missing from the configured catalog: ${tools.unknownActive.join(", ")}.`,
		);
	}
	for (const duplicate of duplicateNames(toolCatalog.map(({ name }) => name))) {
		issues.push(`The configured tool catalog exposes the duplicate name ${duplicate}.`);
	}
	for (const duplicate of duplicateSurfaceNames(extensions.surfaces, "tools")) {
		issues.push(`Multiple visible extension surfaces expose the tool ${duplicate}.`);
	}
	for (const duplicate of duplicateSurfaceNames(extensions.surfaces, "commands")) {
		issues.push(`Multiple visible extension surfaces expose the command ${duplicate}.`);
	}

	return {
		capturedAt,
		sessionId: sanitizeDiagnosticText(ctx.sessionManager.getSessionId(), 128),
		current: {
			provider: ctx.model?.provider ? sanitizeDiagnosticText(ctx.model.provider, 128) : null,
			model: ctx.model?.id ? sanitizeDiagnosticText(ctx.model.id, 256) : null,
			thinkingLevel: sanitizeDiagnosticText(pi.getThinkingLevel(), 32),
		},
		environment: {
			piCodingAgentVersion: resolvePiCodingAgentVersion(),
			nodeVersion: sanitizeDiagnosticText(process.version, 64),
			platform: sanitizeDiagnosticText(process.platform, 32),
			architecture: sanitizeDiagnosticText(process.arch, 32),
		},
		cache: collectCacheMetrics(entries),
		tools,
		toolCatalog,
		extensions,
		issues,
		recentRuntimeRecords: collectRuntimeRecords(entries),
	};
}

export function compareRuntimeSnapshots(from: RuntimeSnapshot, to: RuntimeSnapshot) {
	return {
		fromCapturedAt: from.capturedAt,
		toCapturedAt: to.capturedAt,
		providerChanged: from.provider !== to.provider,
		modelChanged: from.model !== to.model,
		thinkingLevelChanged: from.thinkingLevel !== to.thinkingLevel,
		activeTools: diffNames(from.tools.active, to.tools.active),
		inactiveTools: diffNames(from.tools.inactive, to.tools.inactive),
	};
}

function collectToolState(pi: ExtensionAPI): ToolState {
	const configured = [...pi.getAllTools()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	const configuredNames = new Set(configured.map(({ name }) => sanitizeDiagnosticText(name, 128)));
	const activeNames = [...new Set(pi.getActiveTools())]
		.map((name) => sanitizeDiagnosticText(name, 128))
		.sort((left, right) => left.localeCompare(right));
	const knownActive = activeNames.filter((name) => configuredNames.has(name));
	const inactive = configured
		.map(({ name }) => sanitizeDiagnosticText(name, 128))
		.filter((name) => !activeNames.includes(name));
	const unknownActive = activeNames.filter((name) => !configuredNames.has(name));
	const visible = [...knownActive, ...inactive].slice(0, MAX_TOOL_NAMES);
	const visibleSet = new Set(visible);

	return {
		configuredCount: configured.length,
		activeCount: knownActive.length,
		inactiveCount: inactive.length,
		active: knownActive.filter((name) => visibleSet.has(name)),
		inactive: inactive.filter((name) => visibleSet.has(name)),
		unknownActive,
		omittedCount: Math.max(0, knownActive.length + inactive.length - visible.length),
	};
}

function collectToolCatalog(pi: ExtensionAPI): ToolCatalogEntry[] {
	const active = new Set(pi.getActiveTools());
	return [...pi.getAllTools()]
		.sort((left, right) => left.name.localeCompare(right.name))
		.slice(0, MAX_TOOL_NAMES)
		.map((tool) => {
			const isActive = active.has(tool.name);
			return {
				name: sanitizeDiagnosticText(tool.name, 128),
				active: isActive,
				inactiveReason: isActive
					? null
					: "Registered but not active; Pi does not expose whether configuration, filtering, or deferred loading caused this state.",
				knownProviderDefinitionBytes: jsonByteLength({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				}),
				source: sanitizeSourceInfo(tool.sourceInfo),
			};
		});
}

function collectCacheMetrics(entries: readonly SessionEntry[]): RuntimeDiagnosticReport["cache"] {
	const samples: ResponseCacheSample[] = [];
	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const sample = createCacheSample(
			entry.message.usage,
			entry.message.timestamp,
			entry.message.provider,
			entry.message.model,
		);
		samples.push(sample);
		input += sample.input;
		cacheRead += sample.cacheRead;
		cacheWrite += sample.cacheWrite;
	}
	const promptTokens = input + cacheRead + cacheWrite;
	return {
		requestCount: samples.length,
		input,
		cacheRead,
		cacheWrite,
		promptTokens,
		hitRatePercent: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : null,
		latest: samples.at(-1) ?? null,
		recent: samples.slice(-MAX_CACHE_SAMPLES),
	};
}

function createCacheSample(
	usage: UsageLike,
	capturedAt: number,
	provider?: string,
	model?: string,
): ResponseCacheSample {
	const input = finiteNumber(usage.input);
	const cacheRead = finiteNumber(usage.cacheRead);
	const cacheWrite = finiteNumber(usage.cacheWrite);
	const promptTokens = input + cacheRead + cacheWrite;
	return {
		capturedAt,
		provider: provider ? sanitizeDiagnosticText(provider, 128) : null,
		model: model ? sanitizeDiagnosticText(model, 256) : null,
		input,
		cacheRead,
		cacheWrite,
		promptTokens,
		hitRatePercent: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : null,
	};
}

function collectRuntimeRecords(entries: readonly SessionEntry[]): RuntimeSnapshot[] {
	return entries
		.filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === RUNTIME_ENTRY_TYPE,
		)
		.map(({ data }) => normalizeRuntimeSnapshot(data))
		.filter((snapshot): snapshot is RuntimeSnapshot => snapshot !== undefined)
		.slice(-MAX_RUNTIME_RECORDS);
}

function collectExtensionSurfaces(pi: ExtensionAPI): RuntimeDiagnosticReport["extensions"] {
	const surfaces = new Map<string, ExtensionSurface>();
	const add = (
		sourceInfo: { path: string; source: string; scope: string; origin: string },
		kind: "tools" | "commands",
		name: string,
	) => {
		const sanitizedSource = sanitizeSourceInfo(sourceInfo);
		const key = `${sanitizedSource.path}\u0000${sanitizedSource.source}`;
		const surface = surfaces.get(key) ?? {
			...sanitizedSource,
			version:
				sourceInfo.origin === "package" ? resolveOwningPackageVersion(sourceInfo.path) : null,
			tools: [],
			commands: [],
		};
		surface[kind].push(sanitizeDiagnosticText(name, 128));
		surfaces.set(key, surface);
	};

	for (const tool of pi.getAllTools()) {
		if (tool.sourceInfo.source === "builtin" || tool.sourceInfo.source === "sdk") continue;
		add(tool.sourceInfo, "tools", tool.name);
	}
	for (const command of pi.getCommands()) {
		if (command.source !== "extension") continue;
		add(command.sourceInfo, "commands", command.name);
	}

	const all = [...surfaces.values()]
		.map((surface) => ({
			...surface,
			tools: [...new Set(surface.tools)].sort(),
			commands: [...new Set(surface.commands)].sort(),
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
	return {
		visibility:
			"Only extensions exposing public tools or slash commands are visible; passive event-only extensions are not enumerable through ExtensionAPI.",
		visibleCount: all.length,
		omittedCount: Math.max(0, all.length - MAX_EXTENSION_SURFACES),
		surfaces: all.slice(0, MAX_EXTENSION_SURFACES),
	};
}

function sanitizeSourceInfo(sourceInfo: {
	path: string;
	source: string;
	scope: string;
	origin: string;
}) {
	return {
		path: sanitizeDiagnosticText(sourceInfo.path, 1024),
		source: sanitizeDiagnosticText(sourceInfo.source, 256),
		scope: sanitizeDiagnosticText(sourceInfo.scope, 32),
		origin: sanitizeDiagnosticText(sourceInfo.origin, 32),
	};
}

let cachedPiVersion: string | null | undefined;

function resolvePiCodingAgentVersion(): string | null {
	if (cachedPiVersion !== undefined) return cachedPiVersion;
	try {
		const entryPath = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
		cachedPiVersion = findPackageVersion(entryPath, "@earendil-works/pi-coding-agent");
	} catch {
		cachedPiVersion = null;
	}
	return cachedPiVersion;
}

const packageVersionCache = new Map<string, string | null>();

function resolveOwningPackageVersion(sourcePath: string): string | null {
	if (packageVersionCache.has(sourcePath)) return packageVersionCache.get(sourcePath) ?? null;
	const version = findPackageVersion(sourcePath);
	packageVersionCache.set(sourcePath, version);
	return version;
}

function findPackageVersion(startPath: string, expectedName?: string): string | null {
	let directory = dirname(startPath);
	const root = parse(directory).root;
	for (let depth = 0; depth < 8 && directory !== root; depth += 1) {
		try {
			const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
				name?: unknown;
				version?: unknown;
			};
			if (
				typeof manifest.version === "string" &&
				(!expectedName || manifest.name === expectedName)
			) {
				return sanitizeDiagnosticText(manifest.version, 64);
			}
		} catch {
			// Continue toward the filesystem root until an owning manifest is found.
		}
		directory = dirname(directory);
	}
	return null;
}

function duplicateSurfaceNames(
	surfaces: readonly ExtensionSurface[],
	kind: "tools" | "commands",
): string[] {
	return duplicateNames(surfaces.flatMap((surface) => surface[kind]));
}

function duplicateNames(names: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([name]) => name)
		.sort();
}

function diffNames(from: readonly string[], to: readonly string[]) {
	const previous = new Set(from);
	const current = new Set(to);
	return {
		added: to.filter((name) => !previous.has(name)),
		removed: from.filter((name) => !current.has(name)),
	};
}

function normalizeRuntimeSnapshot(value: unknown): RuntimeSnapshot | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isFiniteNumber(value.capturedAt) ||
		!isRuntimeSnapshotReason(value.reason) ||
		typeof value.sessionId !== "string" ||
		!isNullableString(value.provider) ||
		!isNullableString(value.model) ||
		typeof value.thinkingLevel !== "string"
	) {
		return undefined;
	}
	const tools = normalizeToolState(value.tools);
	const cache = value.cache === null ? null : normalizeCacheSample(value.cache);
	if (!tools || cache === undefined) return undefined;
	return {
		version: 1,
		capturedAt: value.capturedAt,
		reason: value.reason,
		sessionId: sanitizeDiagnosticText(value.sessionId, 128),
		provider: value.provider ? sanitizeDiagnosticText(value.provider, 128) : null,
		model: value.model ? sanitizeDiagnosticText(value.model, 256) : null,
		thinkingLevel: sanitizeDiagnosticText(value.thinkingLevel, 32),
		cache,
		tools,
	};
}

function normalizeToolState(value: unknown): ToolState | undefined {
	if (
		!isRecord(value) ||
		!isNonNegativeInteger(value.configuredCount) ||
		!isNonNegativeInteger(value.activeCount) ||
		!isNonNegativeInteger(value.inactiveCount) ||
		!isNonNegativeInteger(value.omittedCount)
	) {
		return undefined;
	}
	const active = normalizeStringArray(value.active);
	const inactive = normalizeStringArray(value.inactive);
	const unknownActive = normalizeStringArray(value.unknownActive);
	if (!active || !inactive || !unknownActive) return undefined;
	return {
		configuredCount: value.configuredCount,
		activeCount: value.activeCount,
		inactiveCount: value.inactiveCount,
		active,
		inactive,
		unknownActive,
		omittedCount: value.omittedCount,
	};
}

function normalizeCacheSample(value: unknown): ResponseCacheSample | undefined {
	if (
		!isRecord(value) ||
		!isFiniteNumber(value.capturedAt) ||
		!isNullableString(value.provider) ||
		!isNullableString(value.model) ||
		!isNonNegativeNumber(value.input) ||
		!isNonNegativeNumber(value.cacheRead) ||
		!isNonNegativeNumber(value.cacheWrite) ||
		!isNonNegativeNumber(value.promptTokens) ||
		!(value.hitRatePercent === null || isFiniteNumber(value.hitRatePercent))
	) {
		return undefined;
	}
	return {
		capturedAt: value.capturedAt,
		provider: value.provider ? sanitizeDiagnosticText(value.provider, 128) : null,
		model: value.model ? sanitizeDiagnosticText(value.model, 256) : null,
		input: value.input,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		promptTokens: value.promptTokens,
		hitRatePercent: value.hitRatePercent,
	};
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		return undefined;
	}
	return [...new Set(value.map((item) => sanitizeDiagnosticText(item, 128)))]
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right))
		.slice(0, MAX_TOOL_NAMES);
}

function isRuntimeSnapshotReason(value: unknown): value is RuntimeSnapshotReason {
	return RUNTIME_SNAPSHOT_REASONS.includes(value as RuntimeSnapshotReason);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0;
}

function jsonByteLength(value: unknown): number | null {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return null;
	}
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
