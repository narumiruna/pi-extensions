import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const BENCHMARK_ID = "pi-cbmem-retrieval-comparison:v1";
export const ARMS = ["baseline", "cbmem"];
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const CBMEM_TOOLS = [
	"index_repository",
	"search_graph",
	"query_graph",
	"trace_path",
	"get_code_snippet",
	"get_graph_schema",
	"get_architecture",
	"search_code",
	"list_projects",
	"delete_project",
	"index_status",
	"check_index_coverage",
	"detect_changes",
	"manage_adr",
	"ingest_traces",
];
export const CBMEM_READ_ONLY_TOOLS = CBMEM_TOOLS.filter(
	(name) => !["index_repository", "delete_project", "manage_adr", "ingest_traces"].includes(name),
);

const TASK_FIELDS = new Set(["id", "kind", "question", "facts", "exactTool"]);
const SUITE_FIELDS = new Set(["schemaVersion", "id", "description", "tasks"]);
const PROJECT_PLACEHOLDER = `$${"{project}"}`;

export function validateSuite(input) {
	requireObject(input, "suite");
	rejectUnknown(input, SUITE_FIELDS, "suite");
	if (input.schemaVersion !== 1) throw new Error("suite.schemaVersion must equal 1");
	requireString(input.id, "suite.id");
	requireString(input.description, "suite.description");
	if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
		throw new Error("suite.tasks must be a non-empty array");
	}
	const ids = new Set();
	for (const [index, task] of input.tasks.entries()) {
		const label = `suite.tasks[${index}]`;
		requireObject(task, label);
		rejectUnknown(task, TASK_FIELDS, label);
		requireString(task.id, `${label}.id`);
		if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
		ids.add(task.id);
		if (task.kind !== "exact-payload" && task.kind !== "same-evidence") {
			throw new Error(`${label}.kind must be exact-payload or same-evidence`);
		}
		requireString(task.question, `${label}.question`);
		if (!Array.isArray(task.facts) || task.facts.length === 0) {
			throw new Error(`${label}.facts must be a non-empty array`);
		}
		const factIds = new Set();
		for (const [factIndex, fact] of task.facts.entries()) {
			const factLabel = `${label}.facts[${factIndex}]`;
			requireObject(fact, factLabel);
			rejectUnknown(fact, new Set(["id", "expected"]), factLabel);
			requireString(fact.id, `${factLabel}.id`);
			requireString(fact.expected, `${factLabel}.expected`);
			if (factIds.has(fact.id)) throw new Error(`duplicate fact id in ${task.id}: ${fact.id}`);
			factIds.add(fact.id);
		}
		if (task.kind === "exact-payload") validateExactTool(task.exactTool, label);
		else if (task.exactTool !== undefined) {
			throw new Error(`${label}.exactTool is allowed only for exact-payload tasks`);
		}
	}
	return structuredClone(input);
}

export function materializeTask(task, project) {
	return replaceProject(structuredClone(task), project);
}

export function createSchedule(tasks, runs) {
	const schedule = [];
	for (const task of tasks) {
		for (let repetition = 0; repetition < runs; repetition += 1) {
			const order = repetition % 2 === 0 ? ARMS : [...ARMS].reverse();
			for (const arm of order) {
				schedule.push({ taskId: task.id, kind: task.kind, repetition: repetition + 1, arm });
			}
		}
	}
	return schedule;
}

export function buildPrompt({ arm, task, evidencePacket }) {
	const factIds = task.facts.map((fact) => fact.id);
	const schema = JSON.stringify({ answers: Object.fromEntries(factIds.map((id) => [id, "..."])) });
	const lines = [
		"You are a deterministic codebase fact-recovery benchmark agent.",
		"Return only one JSON object with exactly this shape:",
		schema,
		"Every answer must be a string.",
		"Do not include Markdown, commentary, or additional keys.",
		`Question: ${task.question}`,
	];

	if (task.kind === "exact-payload" && arm === "baseline") {
		lines.push("Do not call tools. Use only this evidence packet:", evidencePacket ?? "");
	} else if (task.kind === "exact-payload") {
		lines.push(
			`Call ${task.exactTool.name} exactly once with these exact arguments:`,
			JSON.stringify(task.exactTool.args),
			"Do not call any other tool.",
		);
	} else if (arm === "baseline") {
		lines.push("Use only the available read-only Pi tools to inspect the repository.");
	} else {
		lines.push(
			"Use at least one Codebase Memory tool to acquire evidence.",
			"Target source verification with read-only Pi tools is allowed when needed.",
		);
	}
	return lines.join("\n");
}

export function scoreTrial({ arm, task, responseText, toolCalls, toolResults, evidencePacket }) {
	const errors = [];
	let parsed;
	try {
		parsed = JSON.parse(responseText.trim());
	} catch (error) {
		errors.push(`response is not strict JSON: ${error instanceof Error ? error.message : error}`);
	}
	const answers = parsed?.answers;
	if (!isPlainObject(parsed) || !isPlainObject(answers) || Object.keys(parsed).length !== 1) {
		errors.push("response must contain only an answers object");
	}
	const expectedIds = task.facts.map((fact) => fact.id).sort();
	const actualIds = isPlainObject(answers) ? Object.keys(answers).sort() : [];
	if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
		errors.push("answer keys do not match the required facts");
	}
	const facts = task.facts.map((fact) => {
		const actual = isPlainObject(answers) ? answers[fact.id] : undefined;
		const matched = typeof actual === "string" && actual === fact.expected;
		if (!matched) errors.push(`fact mismatch: ${fact.id}`);
		return { id: fact.id, expected: fact.expected, actual, matched };
	});

	const cbmemCalls = toolCalls.filter((call) => CBMEM_TOOLS.includes(call.name));
	const successfulCbmemResults = toolResults.filter(
		(result) => CBMEM_TOOLS.includes(result.name) && result.isError !== true,
	);
	if (arm === "baseline" && cbmemCalls.length > 0) errors.push("baseline called a cbmem tool");
	if (task.kind === "exact-payload" && arm === "baseline" && toolCalls.length > 0) {
		errors.push("exact-payload baseline called a tool");
	}
	if (task.kind === "same-evidence" && arm === "cbmem" && cbmemCalls.length === 0) {
		errors.push("cbmem arm did not call a cbmem tool");
	}
	if (task.kind === "same-evidence" && arm === "cbmem" && successfulCbmemResults.length === 0) {
		errors.push("cbmem arm had no successful cbmem tool result");
	}
	let exactPayload;
	if (task.kind === "exact-payload" && arm === "cbmem") {
		const expectedCalls = toolCalls.filter((call) => call.name === task.exactTool.name);
		if (toolCalls.length !== 1 || expectedCalls.length !== 1) {
			errors.push("exact-payload cbmem arm did not call only the required tool once");
		}
		if (expectedCalls[0] && !deepEqual(expectedCalls[0].args, task.exactTool.args)) {
			errors.push("exact-payload tool arguments changed");
		}
		const resultText = toolResults.find((result) => result.name === task.exactTool.name)?.text;
		exactPayload = {
			expectedSha256: evidencePacket ? sha256(evidencePacket) : undefined,
			actualSha256: typeof resultText === "string" ? sha256(resultText) : undefined,
			matched: typeof resultText === "string" && resultText === evidencePacket,
		};
		if (!exactPayload.matched) errors.push("exact evidence payload did not match");
	}

	return {
		success: errors.length === 0,
		errors: [...new Set(errors)],
		facts,
		...(exactPayload ? { exactPayload } : {}),
	};
}

export function summarizeTrials(trials) {
	const byArm = Object.fromEntries(ARMS.map((arm) => [arm, summarizeArm(trials, arm)]));
	return {
		attempts: trials.length,
		byArm,
		comparison: {
			successRateDelta: round(byArm.cbmem.successRate - byArm.baseline.successRate),
			medianProviderTokensPerSuccessfulRunDelta: delta(
				byArm.cbmem.successful.providerTokens?.median,
				byArm.baseline.successful.providerTokens?.median,
			),
			medianAgentWallMsPerSuccessfulRunDelta: delta(
				byArm.cbmem.successful.agentWallMs?.median,
				byArm.baseline.successful.agentWallMs?.median,
			),
			p95AgentWallMsDelta: delta(
				byArm.cbmem.successful.agentWallMs?.p95,
				byArm.baseline.successful.agentWallMs?.p95,
			),
		},
	};
}

export function summarizeNumbers(values) {
	if (values.length === 0) return undefined;
	const ordered = [...values].sort((left, right) => left - right);
	const center = median(ordered);
	return {
		count: ordered.length,
		median: round(center),
		medianAbsoluteDeviation: round(
			median(ordered.map((value) => Math.abs(value - center)).sort((left, right) => left - right)),
		),
		p95: round(percentile(ordered, 0.95)),
		min: round(ordered[0]),
		max: round(ordered.at(-1)),
	};
}

export function extractLastJson(output) {
	const trimmed = output.trim();
	if (!trimmed) throw new Error("output contained no JSON");
	try {
		JSON.parse(trimmed);
		return trimmed;
	} catch {
		for (const line of trimmed.split("\n").reverse()) {
			const candidate = line.trim();
			if (!candidate) continue;
			try {
				JSON.parse(candidate);
				return candidate;
			} catch {
				// Continue to the previous complete line.
			}
		}
	}
	throw new Error("output contained no complete JSON response");
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function summarizeArm(trials, arm) {
	const selected = trials.filter((trial) => trial.arm === arm);
	const successful = selected.filter((trial) => trial.score.success);
	const totalProviderTokens = selected.reduce(
		(total, trial) => total + trial.metrics.usage.providerTokens,
		0,
	);
	return {
		attempts: selected.length,
		successes: successful.length,
		successRate: selected.length === 0 ? 0 : round(successful.length / selected.length),
		failures: selected.length - successful.length,
		providerTokensPerSuccess:
			successful.length === 0 ? undefined : round(totalProviderTokens / successful.length),
		successful: {
			providerTokens: summarizeNumbers(
				successful.map((trial) => trial.metrics.usage.providerTokens),
			),
			agentWallMs: summarizeNumbers(successful.map((trial) => trial.metrics.agentWallMs)),
			processWallMs: summarizeNumbers(successful.map((trial) => trial.metrics.processWallMs)),
			startupMs: summarizeNumbers(successful.map((trial) => trial.metrics.startupMs)),
		},
	};
}

function validateExactTool(input, label) {
	requireObject(input, `${label}.exactTool`);
	rejectUnknown(input, new Set(["name", "args"]), `${label}.exactTool`);
	requireString(input.name, `${label}.exactTool.name`);
	if (!CBMEM_TOOLS.includes(input.name)) {
		throw new Error(`${label}.exactTool.name is not a pi-cbmem tool`);
	}
	requireObject(input.args, `${label}.exactTool.args`);
}

function replaceProject(value, project) {
	if (typeof value === "string") return value.replaceAll(PROJECT_PLACEHOLDER, project);
	if (Array.isArray(value)) return value.map((item) => replaceProject(item, project));
	if (!isPlainObject(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, replaceProject(item, project)]),
	);
}

function rejectUnknown(input, allowed, label) {
	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) throw new Error(`${label} has unknown field: ${key}`);
	}
}

function requireObject(value, label) {
	if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
}

function requireString(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left, right) {
	return isDeepStrictEqual(left, right);
}

function median(ordered) {
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function percentile(ordered, fraction) {
	if (ordered.length === 1) return ordered[0];
	const position = (ordered.length - 1) * fraction;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return ordered[lower];
	return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function delta(left, right) {
	return left === undefined || right === undefined ? undefined : round(left - right);
}

function round(value) {
	return Number(value.toFixed(3));
}
