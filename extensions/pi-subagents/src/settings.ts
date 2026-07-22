import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type CompletionDelivery,
	isThinkingLevel,
	type SubagentAgentConfig,
	type SubagentSettings,
	type SubagentThinkingLevel,
} from "./agents.js";

export function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function isPositiveInteger(value: unknown): value is number {
	return isPositiveNumber(value) && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeAgentSettings(value: unknown): SubagentAgentConfig | undefined {
	if (!isPlainObject(value)) return undefined;

	const config: SubagentAgentConfig = {};
	let hasKnownField = false;

	if (hasOwn(value, "tools")) {
		if (!isStringArray(value.tools)) return undefined;
		config.tools = value.tools;
		hasKnownField = true;
	}

	if (hasOwn(value, "model")) {
		if (value.model !== null && typeof value.model !== "string") return undefined;
		config.model = value.model;
		hasKnownField = true;
	}

	if (hasOwn(value, "thinkingLevel")) {
		if (value.thinkingLevel !== null && !isThinkingLevel(value.thinkingLevel)) return undefined;
		config.thinkingLevel = value.thinkingLevel;
		hasKnownField = true;
	}

	if (hasOwn(value, "timeoutMs")) {
		if (value.timeoutMs !== null && !isPositiveNumber(value.timeoutMs)) return undefined;
		config.timeoutMs = value.timeoutMs;
		hasKnownField = true;
	}

	return hasKnownField ? config : undefined;
}

export function normalizeSubagentSettings(value: unknown): SubagentSettings | undefined {
	if (!isPlainObject(value)) return undefined;
	const settings: SubagentSettings = {};
	if (hasOwn(value, "agents")) {
		if (!isPlainObject(value.agents)) return undefined;
		const agents: Record<string, SubagentAgentConfig> = {};
		for (const [name, rawConfig] of Object.entries(value.agents)) {
			const config = normalizeAgentSettings(rawConfig);
			if (config) agents[name] = config;
		}
		if (Object.keys(agents).length > 0) settings.agents = agents;
	}
	if (hasOwn(value, "stateful")) {
		if (!isPlainObject(value.stateful)) return undefined;
		const runtime: NonNullable<SubagentSettings["stateful"]> = {};
		if (hasOwn(value.stateful, "transport")) {
			if (value.stateful.transport !== "subprocess" && value.stateful.transport !== "in-process") {
				return undefined;
			}
			runtime.transport = value.stateful.transport;
		}
		if (hasOwn(value.stateful, "completionDelivery")) {
			if (
				value.stateful.completionDelivery !== "next-turn" &&
				value.stateful.completionDelivery !== "auto-resume"
			) {
				return undefined;
			}
			runtime.completionDelivery = value.stateful.completionDelivery;
		}
		for (const key of [
			"maxAgents",
			"maxActiveTurns",
			"maxChildrenPerAgent",
			"maxMailboxMessages",
			"maxMailboxMessageBytes",
			"idleTtlMs",
			"maxStoredAgents",
		] as const) {
			if (hasOwn(value.stateful, key)) {
				if (!isPositiveInteger(value.stateful[key])) return undefined;
				runtime[key] = value.stateful[key];
			}
		}
		if (hasOwn(value.stateful, "maxDepth")) {
			if (!isNonNegativeInteger(value.stateful.maxDepth)) return undefined;
			runtime.maxDepth = value.stateful.maxDepth;
		}
		if (hasOwn(value.stateful, "retentionDays")) {
			if (!isPositiveNumber(value.stateful.retentionDays)) return undefined;
			runtime.retentionDays = value.stateful.retentionDays;
		}
		if (hasOwn(value.stateful, "enabled")) {
			if (typeof value.stateful.enabled !== "boolean") return undefined;
			runtime.enabled = value.stateful.enabled;
		}
		settings.stateful = runtime;
	}
	return settings;
}

const SETTINGS_FILE = "pi-subagents.json";
const LEGACY_SETTINGS_FILE = "pi-subagents-config.json";
const DEFAULT_COMPLETION_DELIVERY: CompletionDelivery = "next-turn";
let pendingSettingsNotice: string | undefined;

export function readSubagentSettings(): SubagentSettings | undefined {
	pendingSettingsNotice = undefined;
	const canonicalPath = path.join(getAgentDir(), SETTINGS_FILE);
	const legacyPath = path.join(getAgentDir(), LEGACY_SETTINGS_FILE);
	if (fs.existsSync(canonicalPath)) {
		const canonical = readSettingsFile(canonicalPath);
		const notices: string[] = [];
		if (!canonical) notices.push(`${SETTINGS_FILE} is invalid and was ignored.`);
		if (fs.existsSync(legacyPath)) {
			notices.push(`${LEGACY_SETTINGS_FILE} ignored because ${SETTINGS_FILE} takes precedence.`);
		}
		if (notices.length > 0) pendingSettingsNotice = notices.join("\n");
		return canonical;
	}
	if (!fs.existsSync(legacyPath)) return undefined;
	const legacySnapshot = readSettingsSnapshot(legacyPath);
	const legacy = legacySnapshot.settings;
	if (!legacy) {
		pendingSettingsNotice = `${LEGACY_SETTINGS_FILE} is invalid and was ignored.`;
		return undefined;
	}
	let installedIdentity: FileIdentity;
	try {
		installedIdentity = installFileExclusively(canonicalPath, legacySnapshot.contents ?? "");
	} catch (error) {
		if (fs.existsSync(canonicalPath)) {
			const canonical = readSettingsFile(canonicalPath);
			pendingSettingsNotice = [
				...(!canonical ? [`${SETTINGS_FILE} is invalid and was ignored.`] : []),
				`${LEGACY_SETTINGS_FILE} ignored because ${SETTINGS_FILE} was created concurrently.`,
			].join("\n");
			return canonical;
		}
		pendingSettingsNotice = `Subagent settings migration failed: ${formatError(error)}. The legacy file was used for this session.`;
		return legacy;
	}
	if (!fileContentsEqual(legacyPath, legacySnapshot.contents ?? "")) {
		pendingSettingsNotice = removeFileIfIdentityMatches(
			canonicalPath,
			installedIdentity,
			legacySnapshot.contents ?? "",
		)
			? `${LEGACY_SETTINGS_FILE} changed during migration; the stale ${SETTINGS_FILE} snapshot was removed.`
			: `${LEGACY_SETTINGS_FILE} changed during migration, but ${SETTINGS_FILE} was replaced concurrently and takes precedence on the next load.`;
		return legacy;
	}
	try {
		fs.rmSync(legacyPath);
		pendingSettingsNotice = `Subagent settings migrated from ${LEGACY_SETTINGS_FILE} to ${SETTINGS_FILE}.`;
	} catch (error) {
		pendingSettingsNotice = `Subagent settings migrated to ${SETTINGS_FILE}, but ${LEGACY_SETTINGS_FILE} could not be removed: ${formatError(error)}.`;
	}
	return legacy;
}

type FileIdentity = { dev: number; ino: number };

function installFileExclusively(filePath: string, contents: string): FileIdentity {
	const tempFile = path.join(path.dirname(filePath), `.${SETTINGS_FILE}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(tempFile, contents, { encoding: "utf8", flag: "wx" });
		const identity = fs.lstatSync(tempFile);
		fs.linkSync(tempFile, filePath);
		return { dev: identity.dev, ino: identity.ino };
	} finally {
		try {
			fs.rmSync(tempFile, { force: true });
		} catch {
			// Preserve the migration result if best-effort temp cleanup fails.
		}
	}
}

function removeFileIfIdentityMatches(
	filePath: string,
	expected: FileIdentity,
	expectedContents: string,
) {
	try {
		const current = fs.lstatSync(filePath);
		if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
		if (fs.readFileSync(filePath, "utf8") !== expectedContents) return false;
		fs.rmSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function fileContentsEqual(filePath: string, expected: string) {
	try {
		return fs.readFileSync(filePath, "utf8") === expected;
	} catch {
		return false;
	}
}

export function consumeSubagentSettingsNotice() {
	const notice = pendingSettingsNotice;
	pendingSettingsNotice = undefined;
	return notice;
}

export function saveSubagentConfig(settings: SubagentSettings): void {
	writeSettingsObject(settings);
}

export interface CompletionDeliverySettingsSnapshot {
	path: string;
	value: CompletionDelivery;
	source: "default" | "user settings";
	error?: string;
}

export function subagentSettingsFilePath(): string {
	return path.join(getAgentDir(), SETTINGS_FILE);
}

export function inspectCompletionDeliverySettings(): CompletionDeliverySettingsSnapshot {
	const configPath = subagentSettingsFilePath();
	if (!fs.existsSync(configPath)) {
		return { path: configPath, value: DEFAULT_COMPLETION_DELIVERY, source: "default" };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
		const settings = normalizeSubagentSettings(raw);
		if (!settings) throw new Error(`${SETTINGS_FILE} is not a valid settings object`);
		const explicit =
			isPlainObject(raw.stateful) && hasOwn(raw.stateful, "completionDelivery");
		return {
			path: configPath,
			value: settings.stateful?.completionDelivery ?? DEFAULT_COMPLETION_DELIVERY,
			source: explicit ? "user settings" : "default",
		};
	} catch (error) {
		return {
			path: configPath,
			value: DEFAULT_COMPLETION_DELIVERY,
			source: "default",
			error: formatError(error),
		};
	}
}

export function updateCompletionDeliverySetting(value: CompletionDelivery): void {
	const raw = readSettingsObjectForUpdate();
	const stateful = raw.stateful;
	if (stateful !== undefined && !isPlainObject(stateful)) {
		throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
	}
	writeSettingsObject({
		...raw,
		stateful: {
			...(stateful ?? {}),
			completionDelivery: value,
		},
	});
}

export function updateAgentToolsSetting(name: string, tools: string[] | undefined): void {
	const raw = readSettingsObjectForUpdate();
	const rawAgents = raw.agents;
	if (rawAgents !== undefined && !isPlainObject(rawAgents)) {
		throw new Error(`Cannot update invalid ${SETTINGS_FILE} agent settings`);
	}
	const agents = { ...(rawAgents ?? {}) };
	const rawAgent = hasOwn(agents, name) ? agents[name] : undefined;
	if (rawAgent !== undefined && !isPlainObject(rawAgent)) {
		throw new Error(`Cannot update invalid ${SETTINGS_FILE} settings for ${name}`);
	}
	const agent = { ...(rawAgent ?? {}) };
	if (tools === undefined) delete agent.tools;
	else agent.tools = tools;
	if (Object.keys(agent).length > 0) {
		Object.defineProperty(agents, name, {
			value: agent,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	} else {
		delete agents[name];
	}

	const updated = { ...raw };
	if (Object.keys(agents).length > 0) updated.agents = agents;
	else delete updated.agents;
	writeSettingsObject(updated);
}

function readSettingsObjectForUpdate(): Record<string, unknown> {
	const configPath = subagentSettingsFilePath();
	if (!fs.existsSync(configPath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot update malformed ${SETTINGS_FILE}: ${formatError(error)}`);
	}
	if (!isPlainObject(parsed) || !normalizeSubagentSettings(parsed)) {
		throw new Error(`Cannot update invalid ${SETTINGS_FILE}`);
	}
	return parsed;
}

function writeSettingsObject(settings: object): void {
	const agentDir = getAgentDir();
	fs.mkdirSync(agentDir, { recursive: true });
	const configPath = path.join(agentDir, SETTINGS_FILE);
	const tempFile = path.join(agentDir, `.${SETTINGS_FILE}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(tempFile, `${JSON.stringify(settings, null, "\t")}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		fs.renameSync(tempFile, configPath);
	} finally {
		try {
			fs.rmSync(tempFile, { force: true });
		} catch {
			// Preserve the save result if best-effort temp cleanup fails.
		}
	}
}

function readSettingsFile(configPath: string): SubagentSettings | undefined {
	return readSettingsSnapshot(configPath).settings;
}

function readSettingsSnapshot(configPath: string): {
	settings?: SubagentSettings;
	contents?: string;
} {
	try {
		const contents = fs.readFileSync(configPath, "utf8");
		return { settings: normalizeSubagentSettings(JSON.parse(contents)), contents };
	} catch {
		return {};
	}
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function uniqueToolNames(tools: string[]): string[] {
	return [...new Set(tools)];
}

export function sameToolSet(left: string[], right: string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) return false;
	return [...leftSet].every((tool) => rightSet.has(tool));
}

export function resolveSubagentThinkingLevel(
	agents: readonly Pick<AgentConfig, "name" | "thinkingLevel">[],
	agentName: string,
	topLevelThinkingLevel?: SubagentThinkingLevel,
	localThinkingLevel?: SubagentThinkingLevel,
): SubagentThinkingLevel | undefined {
	return (
		localThinkingLevel ??
		topLevelThinkingLevel ??
		agents.find((agent) => agent.name === agentName)?.thinkingLevel
	);
}

export function hasAnyAgentOverride(config: SubagentAgentConfig): boolean {
	return (
		hasOwn(config, "tools") ||
		hasOwn(config, "model") ||
		hasOwn(config, "thinkingLevel") ||
		hasOwn(config, "timeoutMs")
	);
}
