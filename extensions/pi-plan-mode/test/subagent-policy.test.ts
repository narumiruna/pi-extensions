import assert from "node:assert/strict";
import test from "node:test";
import { enforcePlanSubagentAllowlist } from "../src/subagent-policy.js";

const ALLOWED = ["plan-scout", "plan-researcher", "plan-reviewer"];
const READ_ONLY_ACTIONS = [
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
] as const;

test("subagent policy ignores unrelated tools and permits allowed single roles", () => {
	assert.equal(
		enforcePlanSubagentAllowlist("custom_delegate", { agent: "worker" }, ALLOWED),
		undefined,
	);
	assert.equal(
		enforcePlanSubagentAllowlist(
			"subagent",
			{ agent: "plan-scout", task: "Inspect the repository" },
			ALLOWED,
		),
		undefined,
	);
});

test("subagent policy permits verified read-only management actions", () => {
	for (const action of READ_ONLY_ACTIONS) {
		const input =
			action === "get" || action === "models" ? { action, agent: "worker" } : { action };
		assert.equal(
			enforcePlanSubagentAllowlist("subagent", input, ALLOWED),
			undefined,
			JSON.stringify(input),
		);
	}
	assert.equal(enforcePlanSubagentAllowlist("subagent", { action: "list" }, []), undefined);
});

test("subagent policy keeps execution aliases under role checks", () => {
	assert.equal(
		enforcePlanSubagentAllowlist(
			"subagent",
			{ action: "single", agent: "plan-scout", task: "Inspect" },
			ALLOWED,
		),
		undefined,
	);
	for (const input of [
		{ action: "single", agent: "worker", task: "Implement" },
		{ action: "parallel", tasks: [{ agent: "worker", task: "Implement" }] },
		{ action: "TASKS", tasks: [{ agent: "worker", task: "Implement" }] },
	]) {
		assert.match(
			enforcePlanSubagentAllowlist("subagent", input, ALLOWED)?.reason ?? "",
			/role\(s\): worker/,
			JSON.stringify(input),
		);
	}
});

test("subagent policy rejects unknown and non-read-only management actions", () => {
	for (const action of ["create", "update", "resume", "schedule", "future-inspection"]) {
		const input = { action, agent: "plan-scout" };
		assert.match(
			enforcePlanSubagentAllowlist("subagent", input, ALLOWED)?.reason ?? "",
			/not a verified read-only management action or role-checked execution mode/,
			JSON.stringify(input),
		);
	}
});

test("subagent policy blocks disallowed and case-mismatched single roles", () => {
	assert.deepEqual(
		enforcePlanSubagentAllowlist(
			"subagent",
			{ agent: "worker", task: "Implement the change" },
			ALLOWED,
		),
		{
			block: true,
			reason:
				"Plan mode blocks subagent role(s): worker. Allowed Plan subagents: plan-scout, plan-researcher, plan-reviewer.",
		},
	);
	assert.match(
		enforcePlanSubagentAllowlist(
			"subagent",
			{ agent: "Plan-Scout", task: "Inspect the repository" },
			ALLOWED,
		)?.reason ?? "",
		/Plan-Scout/,
	);
});

test("subagent policy checks every parallel task", () => {
	assert.equal(
		enforcePlanSubagentAllowlist(
			"subagent",
			{
				tasks: [
					{ agent: "plan-scout", task: "Inspect A" },
					{ agent: "plan-reviewer", task: "Inspect B" },
				],
			},
			ALLOWED,
		),
		undefined,
	);
	assert.match(
		enforcePlanSubagentAllowlist(
			"subagent",
			{
				tasks: [
					{ agent: "plan-scout", task: "Inspect A" },
					{ agent: "worker", task: "Implement B" },
				],
			},
			ALLOWED,
		)?.reason ?? "",
		/role\(s\): worker/,
	);
});

test("subagent policy checks every chain step and the fan-in aggregator", () => {
	assert.equal(
		enforcePlanSubagentAllowlist(
			"subagent",
			{
				chain: [
					{ agent: "plan-scout", task: "Inspect" },
					{ agent: "plan-reviewer", task: "Review {previous}" },
				],
			},
			ALLOWED,
		),
		undefined,
	);
	assert.equal(
		enforcePlanSubagentAllowlist(
			"subagent",
			{
				tasks: [{ agent: "plan-scout", task: "Inspect" }],
				aggregator: { agent: "plan-reviewer", task: "Combine {previous}" },
			},
			ALLOWED,
		),
		undefined,
	);
	assert.match(
		enforcePlanSubagentAllowlist(
			"subagent",
			{
				chain: [
					{ agent: "plan-scout", task: "Inspect" },
					{ agent: "worker", task: "Use {previous}" },
				],
			},
			ALLOWED,
		)?.reason ?? "",
		/role\(s\): worker/,
	);
	assert.match(
		enforcePlanSubagentAllowlist(
			"subagent",
			{
				tasks: [{ agent: "plan-scout", task: "Inspect" }],
				aggregator: { agent: "worker", task: "Combine {previous}" },
			},
			ALLOWED,
		)?.reason ?? "",
		/role\(s\): worker/,
	);
});

test("subagent policy checks detached spawn roles", () => {
	assert.equal(
		enforcePlanSubagentAllowlist(
			"subagent_spawn",
			{ agent: "plan-researcher", task: "Research" },
			ALLOWED,
		),
		undefined,
	);
	assert.match(
		enforcePlanSubagentAllowlist("subagent_spawn", { agent: "worker", task: "Implement" }, ALLOWED)
			?.reason ?? "",
		/role\(s\): worker/,
	);
});

test("subagent policy rejects malformed covered launch payloads", () => {
	for (const [toolName, input] of [
		["subagent", undefined],
		["subagent", {}],
		["subagent", { agent: "" }],
		["subagent", { tasks: [] }],
		["subagent", { tasks: [{ task: "Missing role" }] }],
		["subagent", { chain: "plan-scout" }],
		["subagent", { aggregator: {} }],
		["subagent", { action: "" }],
		["subagent", { action: 42 }],
		["subagent_spawn", {}],
		["subagent_spawn", { action: "list" }],
	] as const) {
		assert.match(
			enforcePlanSubagentAllowlist(toolName, input, ALLOWED)?.reason ?? "",
			/could not verify subagent roles/,
			`${toolName}: ${JSON.stringify(input)}`,
		);
	}
});

test("an empty allowlist denies every valid covered launch", () => {
	assert.deepEqual(
		enforcePlanSubagentAllowlist("subagent", { agent: "plan-scout", task: "Inspect" }, []),
		{
			block: true,
			reason:
				"Plan mode blocks subagent role(s): plan-scout. No subagent roles are allowed in Plan mode.",
		},
	);
});
