import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import {
	type CloneRepository,
	defaultCacheRoot,
	GitCommandError,
	runGitClone,
	SessionSkillResolver,
} from "./resolver.js";

const execFileAsync = promisify(execFile);

import { parseSkillSource } from "./source-parser.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	temporaryPaths.push(path);
	return path;
}

async function writeSkill(
	parent: string,
	directory: string,
	name: string,
	extra = false,
): Promise<string> {
	const root = join(parent, directory);
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "SKILL.md"),
		`---\nname: ${name}\ndescription: Use ${name} in tests.\n---\n\n# ${name}\n`,
	);
	if (extra) {
		await mkdir(join(root, "scripts"));
		await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
	}
	return root;
}

test("copies and caches one local skill without linking it", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-local-");
	const cacheRoot = join(workspace, "cache");
	const skillRoot = await writeSkill(workspace, "source", "demo-skill", true);
	const resolver = new SessionSkillResolver({ cacheRoot });
	const source = parseSkillSource(skillRoot, workspace);

	const first = await resolver.resolve({ source });
	assert.equal(first.name, "demo-skill");
	assert.equal(first.cacheHit, false);
	assert.notEqual(first.path, skillRoot);
	assert.equal(
		await readFile(join(first.path, "scripts", "run.sh"), "utf8"),
		"#!/bin/sh\necho ok\n",
	);
	assert.notEqual((await stat(join(first.path, "scripts", "run.sh"))).mode & 0o111, 0);
	assert.equal((await stat(join(cacheRoot, "entries"))).mode & 0o077, 0);

	const second = await resolver.resolve({ source });
	assert.equal(second.cacheHit, true);
	assert.equal(second.path, first.path);
});

test("ignores frontmatter in Markdown files that are not named SKILL.md", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-decoy-");
	await writeSkill(workspace, "catalog/demo", "real-skill");
	await writeFile(
		join(workspace, "DESIGN.md"),
		"---\nname: decoy\ndescription: This is design metadata, not a skill.\n---\n",
	);
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const result = await resolver.resolve({ source: parseSkillSource(workspace, workspace) });
	assert.equal(result.name, "real-skill");
});

test("selects one skill from a multi-skill source", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-select-");
	await writeSkill(workspace, "skills/alpha", "alpha");
	await writeSkill(workspace, "skills/beta", "beta");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource("./skills", workspace);

	await assert.rejects(() => resolver.resolve({ source }), /multiple skills.*alpha, beta/i);
	const selected = await resolver.resolve({ source, selector: "beta" });
	assert.equal(selected.name, "beta");
});

test("rejects duplicate skill names instead of choosing a discovery winner", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-duplicate-");
	await writeSkill(workspace, "skills/first", "duplicate");
	await writeSkill(workspace, "skills/second", "duplicate");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	await assert.rejects(
		() =>
			resolver.resolve({ source: parseSkillSource("./skills", workspace), selector: "duplicate" }),
		/duplicate names: duplicate/,
	);
});

test("refresh replaces a cache entry only after the new skill validates", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-refresh-");
	const skillRoot = await writeSkill(workspace, "source", "refreshable");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(skillRoot, workspace);
	const first = await resolver.resolve({ source });

	await writeFile(join(skillRoot, "SKILL.md"), "---\nname: refreshable\n---\n\n# Invalid\n");
	await assert.rejects(() => resolver.resolve({ source, refresh: true }), /No valid skills/);
	assert.doesNotMatch(await readFile(join(first.path, "SKILL.md"), "utf8"), /Invalid/);

	await writeFile(
		join(skillRoot, "SKILL.md"),
		"---\nname: refreshable\ndescription: Updated description.\n---\n\n# Updated\n",
	);
	const cached = await resolver.resolve({ source });
	assert.doesNotMatch(await readFile(join(cached.path, "SKILL.md"), "utf8"), /Updated/);
	const refreshed = await resolver.resolve({ source, refresh: true });
	assert.equal(refreshed.path, first.path);
	assert.match(await readFile(join(refreshed.path, "SKILL.md"), "utf8"), /Updated/);
});

test("rejects symbolic links in a skill and removes staging files", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-symlink-");
	const skillRoot = await writeSkill(workspace, "source", "unsafe-skill");
	await writeFile(join(workspace, "secret.txt"), "secret");
	await symlink(join(workspace, "secret.txt"), join(skillRoot, "secret-link"));
	const cacheRoot = join(workspace, "cache");
	const resolver = new SessionSkillResolver({ cacheRoot });

	await assert.rejects(
		() => resolver.resolve({ source: parseSkillSource(skillRoot, workspace) }),
		/symbolic link/,
	);
	assert.deepEqual(await readdir(join(cacheRoot, "staging")), []);
});

test("uses a clone adapter for Git sources and forwards the ref", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-git-");
	const fixture = join(workspace, "fixture");
	await writeSkill(fixture, "skills/demo", "git-skill");
	const calls: Array<{ repository: string; ref?: string }> = [];
	const cloneRepository: CloneRepository = async (repository, target, ref) => {
		calls.push({ repository, ref });
		await cp(fixture, target, { recursive: true });
	};
	const resolver = new SessionSkillResolver({
		cacheRoot: join(workspace, "cache"),
		cloneRepository,
	});
	const source = parseSkillSource("https://github.com/owner/repo/tree/main/skills/demo", workspace);
	const result = await resolver.resolve({ source });

	assert.equal(result.name, "git-skill");
	assert.deepEqual(calls, [{ repository: "https://github.com/owner/repo.git", ref: "main" }]);
});

test("retries a GitHub authentication failure over SSH", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-ssh-fallback-");
	const fixture = join(workspace, "fixture");
	await writeSkill(fixture, "demo", "private-skill");
	const repositories: string[] = [];
	const cloneRepository: CloneRepository = async (repository, target) => {
		repositories.push(repository);
		if (repositories.length === 1) {
			throw new GitCommandError("Git clone failed.", "Repository not found");
		}
		await cp(fixture, target, { recursive: true });
	};
	const resolver = new SessionSkillResolver({
		cacheRoot: join(workspace, "cache"),
		cloneRepository,
	});
	const result = await resolver.resolve({ source: parseSkillSource("owner/private", workspace) });
	assert.equal(result.name, "private-skill");
	assert.deepEqual(repositories, [
		"https://github.com/owner/private.git",
		"git@github.com:owner/private.git",
	]);
});

test("clones through the system Git executable", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-real-git-");
	const source = join(workspace, "source.git");
	const target = join(workspace, "clone");
	await execFileAsync("git", ["init", "--bare", source]);
	await runGitClone(`file://${source}`, target, undefined, undefined);
	assert.ok((await stat(join(target, ".git"))).isDirectory());
});

test("honors cancellation before resolution starts", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-cancel-");
	const skillRoot = await writeSkill(workspace, "source", "cancelled-skill");
	const controller = new AbortController();
	controller.abort();
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	await assert.rejects(
		() =>
			resolver.resolve({
				source: parseSkillSource(skillRoot, workspace),
				signal: controller.signal,
			}),
		/aborted/i,
	);
});

test("chooses a private cache root and ignores relative XDG_CACHE_HOME", () => {
	assert.equal(
		defaultCacheRoot({ XDG_CACHE_HOME: "/var/cache/user" }, "/home/test"),
		"/var/cache/user/pi/session-skills",
	);
	assert.equal(
		defaultCacheRoot({ XDG_CACHE_HOME: "relative" }, "/home/test"),
		"/home/test/.cache/pi/session-skills",
	);
});
