import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeSubpath, parseSkillSource, resolveSkillSelector } from "./source-parser.js";

test("parses GitHub shorthand and optional skill selector", () => {
	assert.deepEqual(parseSkillSource("owner/repo", "/work"), {
		kind: "git",
		original: "owner/repo",
		repository: "https://github.com/owner/repo.git",
		sshFallback: "git@github.com:owner/repo.git",
	});
	const selected = parseSkillSource("owner/repo@diagram", "/work");
	assert.equal(selected.selector, "diagram");
	assert.equal(resolveSkillSelector(selected), "diagram");
	assert.throws(() => resolveSkillSelector(selected, "other"), /Conflicting skill selectors/);
});

test("parses GitHub and GitLab tree URLs", () => {
	assert.deepEqual(
		parseSkillSource("https://github.com/owner/repo/tree/main/skills/foo", "/work"),
		{
			kind: "git",
			original: "https://github.com/owner/repo/tree/main/skills/foo",
			repository: "https://github.com/owner/repo.git",
			ref: "main",
			subpath: "skills/foo",
			sshFallback: "git@github.com:owner/repo.git",
		},
	);
	assert.deepEqual(
		parseSkillSource("https://gitlab.com/group/subgroup/repo/-/tree/v1/skills/foo", "/work"),
		{
			kind: "git",
			original: "https://gitlab.com/group/subgroup/repo/-/tree/v1/skills/foo",
			repository: "https://gitlab.com/group/subgroup/repo.git",
			ref: "v1",
			subpath: "skills/foo",
		},
	);
});

test("parses explicit SSH, HTTPS, and local sources", () => {
	assert.deepEqual(parseSkillSource("git@github.com:owner/repo.git", "/work"), {
		kind: "git",
		original: "git@github.com:owner/repo.git",
		repository: "git@github.com:owner/repo.git",
	});
	assert.deepEqual(parseSkillSource("ssh://git@example.com/team/repo.git", "/work"), {
		kind: "git",
		original: "ssh://git@example.com/team/repo.git",
		repository: "ssh://git@example.com/team/repo.git",
	});
	assert.deepEqual(parseSkillSource("https://example.com/team/repo.git", "/work"), {
		kind: "git",
		original: "https://example.com/team/repo.git",
		repository: "https://example.com/team/repo.git",
	});
	assert.deepEqual(parseSkillSource("./skills/foo", "/work/project"), {
		kind: "local",
		original: "./skills/foo",
		localPath: "/work/project/skills/foo",
	});
});

test("rejects unsupported protocols, embedded credentials, and unsafe paths", () => {
	assert.throws(
		() => parseSkillSource("http://example.com/repo.git", "/work"),
		/Unsupported Git protocol/,
	);
	assert.throws(
		() => parseSkillSource("https://user:secret@example.com/repo.git", "/work"),
		/Credentials must not be embedded/,
	);
	assert.throws(
		() => parseSkillSource("https://github.com/owner/repo/tree/../secret", "/work"),
		/Unsafe repository path/,
	);
	assert.throws(() => normalizeSubpath("skills/../secret"), /Unsafe repository subpath/);
	assert.throws(() => parseSkillSource("owner/repo\u001b[31m", "/work"), /Invalid skill source/);
});
