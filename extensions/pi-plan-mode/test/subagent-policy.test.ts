import assert from "node:assert/strict";
import test from "node:test";
import { enforcePlanSubagentAllowlist } from "../src/subagent-policy.js";

const ALLOWED = ["plan-scout", "plan-researcher", "plan-reviewer"];

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
		["subagent_spawn", {}],
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
