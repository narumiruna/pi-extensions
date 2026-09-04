import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
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
	type ResolveSessionSkillOptions,
	runGitClone,
	SessionSkillResolver,
	type SkillResolverLike,
	windowsProcessTreeKillArguments,
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

async function resolveAndCommit(resolver: SkillResolverLike, options: ResolveSessionSkillOptions) {
	const result = await resolver.resolve(options);
	await result.transaction?.commit();
	return result;
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

	const first = await resolveAndCommit(resolver, { source });
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
	const first = await resolveAndCommit(resolver, { source });

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
	assert.notEqual(refreshed.path, first.path);
	assert.match(await readFile(join(refreshed.path, "SKILL.md"), "utf8"), /Updated/);
	await refreshed.transaction?.commit();
	assert.doesNotMatch(await readFile(join(first.path, "SKILL.md"), "utf8"), /Updated/);
});

test("keeps the previous cache current until a refresh transaction commits", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-transaction-");
	const skillRoot = await writeSkill(workspace, "source", "old-name");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(skillRoot, workspace);
	const original = await resolveAndCommit(resolver, { source });

	await writeFile(
		join(skillRoot, "SKILL.md"),
		"---\nname: new-name\ndescription: Renamed skill.\n---\n",
	);
	const refreshed = await resolver.resolve({ source, refresh: true });
	assert.equal(refreshed.previousName, "old-name");
	assert.notEqual(refreshed.path, original.path);
	assert.equal((await resolver.resolve({ source })).name, "old-name");

	await refreshed.transaction?.rollback();
	assert.equal((await resolver.resolve({ source })).path, original.path);
});

test("excludes a nested cache root from broad local discovery", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-cache-subtree-");
	await writeSkill(workspace, "skills/source", "source-skill");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, ".cache") });
	const source = parseSkillSource(workspace, workspace);
	await resolveAndCommit(resolver, { source });

	const refreshed = await resolver.resolve({ source, refresh: true });
	assert.equal(refreshed.name, "source-skill");
	await refreshed.transaction?.rollback();
});

test("does not copy a cache nested inside a local skill root", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-root-cache-");
	const skillRoot = await writeSkill(workspace, ".", "root-skill");
	const cacheRoot = join(workspace, ".cache");
	const resolver = new SessionSkillResolver({ cacheRoot });
	const result = await resolver.resolve({ source: parseSkillSource(skillRoot, workspace) });
	await assert.rejects(() => stat(join(result.path, ".cache")), { code: "ENOENT" });
	await result.transaction?.rollback();
});

test("populates read-only directories before restoring their modes", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-read-only-");
	const skillRoot = await writeSkill(workspace, "source", "read-only-skill", true);
	const scriptsPath = join(skillRoot, "scripts");
	await chmod(scriptsPath, 0o555);
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const result = await resolver.resolve({ source: parseSkillSource(skillRoot, workspace) });
	const copiedScripts = join(result.path, "scripts");
	assert.equal((await stat(copiedScripts)).mode & 0o777, 0o555);
	assert.match(await readFile(join(copiedScripts, "run.sh"), "utf8"), /echo ok/);
	await chmod(scriptsPath, 0o755);
	await chmod(copiedScripts, 0o755);
	await result.transaction?.rollback();
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

test("fetches and checks out a commit hash without treating it as a branch", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-commit-");
	const source = join(workspace, "source");
	const target = join(workspace, "clone");
	await execFileAsync("git", ["init", source]);
	await writeSkill(source, "skill", "commit-skill");
	await execFileAsync("git", ["-C", source, "add", "."]);
	await execFileAsync("git", [
		"-C",
		source,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-m",
		"fixture",
	]);
	const { stdout } = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]);
	const commit = stdout.trim();
	assert.match(commit, /^[0-9a-f]{40}$/u);

	await runGitClone(`file://${source}`, target, commit, undefined);
	assert.match(await readFile(join(target, "skill", "SKILL.md"), "utf8"), /commit-skill/);
});

test("builds a forced Windows process-tree termination command", () => {
	assert.deepEqual(windowsProcessTreeKillArguments(42), ["/PID", "42", "/T", "/F"]);
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
