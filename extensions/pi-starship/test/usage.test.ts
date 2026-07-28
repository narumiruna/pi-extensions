import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { summarizeFooterUsage } from "../src/usage.js";

function entry(value: unknown): SessionEntry {
	return value as SessionEntry;
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

test("footer usage includes every usage-bearing session entry and uses the latest assistant rate", () => {
	const entries = [
		entry({
			type: "message",
			message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) },
		}),
		entry({
			type: "message",
			message: { role: "toolResult", usage: usage(3, 1, 4, 1, 0.02) },
		}),
		entry({ type: "compaction", usage: usage(2, 1, 0, 2, 0.03) }),
		entry({ type: "branch_summary", usage: usage(1, 1, 1, 0, 0.04) }),
		entry({
			type: "message",
			message: { role: "assistant", usage: usage(80, 4, 20, 0, 0.01) },
		}),
	];

	const result = summarizeFooterUsage(entries);
	assert.deepEqual(
		{ ...result, cost: undefined },
		{
			input: 96,
			output: 9,
			cacheRead: 55,
			cacheWrite: 8,
			cost: undefined,
			latestCacheHitRate: 20,
		},
	);
	assert.ok(Math.abs(result.cost - 0.2) < Number.EPSILON);
});

test("a latest zero-prompt assistant clears the rate without clearing cumulative cache totals", () => {
	const result = summarizeFooterUsage([
		entry({
			type: "message",
			message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) },
		}),
		entry({
			type: "message",
			message: { role: "assistant", usage: usage(0, 0, 0, 0, 0) },
		}),
	]);

	assert.equal(result.cacheRead, 30);
	assert.equal(result.cacheWrite, 5);
	assert.equal(result.latestCacheHitRate, undefined);
});

test("sessions without cache activity retain zero cache totals and a zero latest rate", () => {
	assert.deepEqual(
		summarizeFooterUsage([
			entry({
				type: "message",
				message: { role: "assistant", usage: usage(25, 5, 0, 0, 0.01) },
			}),
		]),
		{
			input: 25,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			latestCacheHitRate: 0,
		},
	);
});
