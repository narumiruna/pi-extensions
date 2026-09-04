import assert from "node:assert/strict";
import { test } from "vitest";
import {
	parseSessionSkillsCommandArguments,
	SESSION_SKILLS_USAGE,
	tokenizeCommandArguments,
} from "./command-parser.js";

test("tokenizes quoted, escaped, and Windows-style command arguments", () => {
	assert.deepEqual(tokenizeCommandArguments(`load ./skill\\ repo --skill "web design" --refresh`), [
		"load",
		"./skill repo",
		"--skill",
		"web design",
		"--refresh",
	]);
	assert.deepEqual(tokenizeCommandArguments(`load 'skill repo'`), ["load", "skill repo"]);
	assert.deepEqual(tokenizeCommandArguments(`load C:\\Users\\name\\skill`), [
		"load",
		`C:\\Users\\name\\skill`,
	]);
	const uncPath = String.raw`\\server\share\skill`;
	assert.deepEqual(tokenizeCommandArguments(`load ${uncPath}`), ["load", uncPath]);
	assert.deepEqual(tokenizeCommandArguments(`load "${uncPath}"`), ["load", uncPath]);
	assert.throws(() => tokenizeCommandArguments(`load "unfinished`), /Unterminated quote/);
});

test("parses the status and list routes", () => {
	assert.deepEqual(parseSessionSkillsCommandArguments(""), { action: "status" });
	assert.deepEqual(parseSessionSkillsCommandArguments("list"), { action: "list" });
	assert.throws(() => parseSessionSkillsCommandArguments("list extra"), {
		message: SESSION_SKILLS_USAGE,
	});
});

test("parses the load route and rejects unknown input", () => {
	assert.deepEqual(
		parseSessionSkillsCommandArguments("load owner/repo --skill example-skill --refresh"),
		{
			action: "load",
			source: "owner/repo",
			skill: "example-skill",
			refresh: true,
		},
	);
	assert.deepEqual(parseSessionSkillsCommandArguments("load --refresh ./local"), {
		action: "load",
		source: "./local",
		refresh: true,
	});
	for (const input of ["load", "load owner/repo extra", "load owner/repo --unknown", "unknown"]) {
		assert.throws(() => parseSessionSkillsCommandArguments(input), {
			message: SESSION_SKILLS_USAGE,
		});
	}
});

test("parses the unload route", () => {
	assert.deepEqual(parseSessionSkillsCommandArguments("unload example-skill"), {
		action: "unload",
		all: false,
		name: "example-skill",
	});
	assert.deepEqual(parseSessionSkillsCommandArguments("unload --all"), {
		action: "unload",
		all: true,
	});
	assert.throws(() => parseSessionSkillsCommandArguments("unload"), {
		message: SESSION_SKILLS_USAGE,
	});
});
