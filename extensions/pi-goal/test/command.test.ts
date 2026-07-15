import assert from "node:assert/strict";
import test from "node:test";
import { completeGoalArguments, parseCommand } from "../src/command.js";

const QUEUE_FEATURE = { experimentalGoals: true } as const;

test("default command parsing keeps queue words inside ordinary objectives", () => {
	for (const objective of [
		"add docs",
		"prioritize outage",
		"drop-last",
		"skip",
		"push docs",
		"unshift outage",
		"pop",
		"shift",
	]) {
		assert.deepEqual(parseCommand(objective), {
			kind: "start",
			objective,
			tokenBudget: undefined,
		});
	}

	const completions = completeGoalArguments("") ?? [];
	assert.equal(
		completions.some(({ label }) => label === "add"),
		false,
	);
	assert.equal(
		completions.some(({ label }) => label === "push"),
		false,
	);
});

test("experimental queue commands normalize canonical names and hidden aliases", () => {
	for (const [input, expected] of [
		["add docs", { kind: "add", objective: "docs", tokenBudget: undefined }],
		["push docs", { kind: "add", objective: "docs", tokenBudget: undefined }],
		["prioritize outage", { kind: "prioritize", objective: "outage", tokenBudget: undefined }],
		["unshift outage", { kind: "prioritize", objective: "outage", tokenBudget: undefined }],
		["drop-last", { kind: "drop-last" }],
		["pop", { kind: "drop-last" }],
		["skip", { kind: "skip" }],
		["shift", { kind: "skip" }],
	] as const) {
		assert.deepEqual(parseCommand(input, QUEUE_FEATURE), expected);
	}

	assert.deepEqual(parseCommand("add --tokens 2k docs", QUEUE_FEATURE), {
		kind: "add",
		objective: "docs",
		tokenBudget: 2_000,
	});
	assert.deepEqual(parseCommand("prioritize --tokens 3k outage", QUEUE_FEATURE), {
		kind: "prioritize",
		objective: "outage",
		tokenBudget: 3_000,
	});
});

test("experimental autocomplete exposes intent names but keeps aliases hidden", () => {
	const completions = completeGoalArguments("", QUEUE_FEATURE) ?? [];
	assert.deepEqual(
		completions
			.filter(({ label }) => ["add", "prioritize", "drop-last", "skip"].includes(label))
			.map(({ label }) => label),
		["add", "prioritize", "drop-last", "skip"],
	);
	for (const alias of ["push", "unshift", "pop", "shift"]) {
		assert.equal(
			completions.some(({ label }) => label === alias),
			false,
		);
	}
	assert.deepEqual(completeGoalArguments("add ", QUEUE_FEATURE), [
		{
			value: "add --tokens ",
			label: "--tokens",
			description: "Set a token budget before the queued goal",
		},
	]);
});
