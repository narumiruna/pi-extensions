export interface PlanSubagentPolicyBlock {
	block: true;
	reason: string;
}

const COVERED_SUBAGENT_TOOLS = new Set(["subagent", "subagent_spawn"]);
const READ_ONLY_SUBAGENT_ACTIONS = new Set([
	"list",
	"get",
	"models",
	"status",
	"doctor",
	"watchdog.status",
	"watchdog.check",
	"watchdog.recommend-model",
	"schedule-list",
	"schedule-status",
]);
const SUBAGENT_EXECUTION_ACTION_ALIASES = new Set(["single", "parallel", "tasks"]);

type BlockingCallClassification =
	| { kind: "launch" }
	| { kind: "read-only" }
	| { kind: "malformed" }
	| { kind: "unsupported" };

export function enforcePlanSubagentAllowlist(
	toolName: string,
	input: unknown,
	allowedRoleNames: readonly string[],
): PlanSubagentPolicyBlock | undefined {
	if (!COVERED_SUBAGENT_TOOLS.has(toolName)) return undefined;

	const allowedNames = unique(allowedRoleNames);
	let requestedRoleNames: string[] | undefined;
	if (toolName === "subagent_spawn") {
		requestedRoleNames = readSpawnRoleNames(input);
	} else {
		const classification = classifyBlockingCall(input);
		if (classification.kind === "read-only") return undefined;
		if (classification.kind === "unsupported") {
			return {
				block: true,
				reason: `Plan mode blocks this subagent action because it is not a verified read-only management action or role-checked execution mode. ${formatAllowedRoles(allowedNames)}`,
			};
		}
		if (classification.kind === "malformed") {
			return unverifiedRolesBlock(toolName, allowedNames);
		}
		requestedRoleNames = readBlockingRoleNames(input);
	}
	if (!requestedRoleNames) return unverifiedRolesBlock(toolName, allowedNames);

	const allowed = new Set(allowedNames);
	const disallowedNames = unique(requestedRoleNames).filter((name) => !allowed.has(name));
	if (disallowedNames.length === 0) return undefined;

	return {
		block: true,
		reason: `Plan mode blocks subagent role(s): ${disallowedNames.join(", ")}. ${formatAllowedRoles(allowedNames)}`,
	};
}

function classifyBlockingCall(input: unknown): BlockingCallClassification {
	if (!isRecord(input) || !Object.hasOwn(input, "action")) return { kind: "launch" };
	const action = input.action;
	if (typeof action !== "string" || action.trim().length === 0) return { kind: "malformed" };
	if (READ_ONLY_SUBAGENT_ACTIONS.has(action)) return { kind: "read-only" };
	if (SUBAGENT_EXECUTION_ACTION_ALIASES.has(action.toLowerCase())) return { kind: "launch" };
	return { kind: "unsupported" };
}

function unverifiedRolesBlock(
	toolName: string,
	allowedNames: readonly string[],
): PlanSubagentPolicyBlock {
	return {
		block: true,
		reason: `Plan mode could not verify subagent roles for tool '${toolName}'. ${formatAllowedRoles(allowedNames)}`,
	};
}

function readSpawnRoleNames(input: unknown) {
	if (!isRecord(input)) return undefined;
	const agent = readRoleName(input.agent);
	return agent ? [agent] : undefined;
}

function readBlockingRoleNames(input: unknown) {
	if (!isRecord(input)) return undefined;
	const roleNames: string[] = [];
	let hasRoleField = false;

	if (Object.hasOwn(input, "agent")) {
		hasRoleField = true;
		const agent = readRoleName(input.agent);
		if (!agent) return undefined;
		roleNames.push(agent);
	}
	for (const field of ["tasks", "chain"] as const) {
		if (!Object.hasOwn(input, field)) continue;
		hasRoleField = true;
		const agents = readRoleArray(input[field]);
		if (!agents) return undefined;
		roleNames.push(...agents);
	}
	if (Object.hasOwn(input, "aggregator")) {
		hasRoleField = true;
		if (!isRecord(input.aggregator)) return undefined;
		const agent = readRoleName(input.aggregator.agent);
		if (!agent) return undefined;
		roleNames.push(agent);
	}

	return hasRoleField && roleNames.length > 0 ? roleNames : undefined;
}

function readRoleArray(value: unknown) {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const roleNames: string[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const agent = readRoleName(item.agent);
		if (!agent) return undefined;
		roleNames.push(agent);
	}
	return roleNames;
}

function readRoleName(value: unknown) {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatAllowedRoles(allowedRoleNames: readonly string[]) {
	return allowedRoleNames.length > 0
		? `Allowed Plan subagents: ${allowedRoleNames.join(", ")}.`
		: "No subagent roles are allowed in Plan mode.";
}

function unique(values: readonly string[]) {
	return Array.from(new Set(values));
}
