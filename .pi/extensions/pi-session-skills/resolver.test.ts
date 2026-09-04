import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import {
	type CloneRepository,
	defaultCacheRoot,
	GitCommandError,
	isRelativePathInside,
	isValidSkillName,
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

test("reuses legacy flat cache entries without skill-directory metadata", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-legacy-cache-");
	const skillRoot = await writeSkill(workspace, "source", "legacy-skill");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(skillRoot, workspace);
	const original = await resolveAndCommit(resolver, { source });
	const versionPath = dirname(dirname(original.path));
	const metadataPath = join(versionPath, "metadata.json");
	const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
		skillDirectory?: string;
	};
	delete metadata.skillDirectory;
	await writeFile(metadataPath, JSON.stringify(metadata));
	const flatSkillPath = dirname(original.path);
	const temporarySkillPath = join(versionPath, "legacy-skill");
	await rename(original.path, temporarySkillPath);
	await rm(flatSkillPath, { recursive: true });
	await rename(temporarySkillPath, flatSkillPath);

	const cached = await resolver.resolve({ source });
	assert.equal(cached.cacheHit, true);
	assert.equal(cached.path, flatSkillPath);
});

test("preserves inferred skill names in the cache layout", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-inferred-name-");
	const skillRoot = join(workspace, "inferred-skill");
	await mkdir(skillRoot);
	await writeFile(join(skillRoot, "SKILL.md"), "---\ndescription: Inferred name.\n---\n");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(skillRoot, workspace);

	const first = await resolveAndCommit(resolver, { source });
	assert.equal(first.name, "inferred-skill");
	assert.equal(basename(dirname(first.path)), "skill");
	assert.equal(basename(first.path), "inferred-skill");
	const second = await resolver.resolve({ source });
	assert.equal(second.cacheHit, true);
	assert.equal(second.path, first.path);
});

test("rejects invalid skill names before caching", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-invalid-name-");
	const skillRoot = join(workspace, "source");
	await mkdir(skillRoot);
	await writeFile(
		join(skillRoot, "SKILL.md"),
		'---\nname: "evil\\u001b[31m"\ndescription: Unsafe name.\n---\n',
	);
	const cacheRoot = join(workspace, "cache");
	const resolver = new SessionSkillResolver({ cacheRoot });

	await assert.rejects(
		() => resolver.resolve({ source: parseSkillSource(skillRoot, workspace) }),
		/invalid name/,
	);
	assert.deepEqual(await readdir(join(cacheRoot, "staging")), []);
});

test("does not reuse cached skills with invalid names", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-invalid-cache-name-");
	const skillRoot = await writeSkill(workspace, "source", "valid-skill");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(skillRoot, workspace);
	const original = await resolveAndCommit(resolver, { source });
	const metadataPath = join(dirname(dirname(original.path)), "metadata.json");
	const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { name: string };
	metadata.name = "evil\u001b[31m";
	await writeFile(metadataPath, JSON.stringify(metadata));
	await writeFile(
		join(original.path, "SKILL.md"),
		'---\nname: "evil\\u001b[31m"\ndescription: Unsafe name.\n---\n',
	);

	const replacement = await resolver.resolve({ source });
	assert.equal(replacement.cacheHit, false);
	assert.equal(replacement.name, "valid-skill");
	assert.notEqual(replacement.path, original.path);
	await replacement.transaction?.rollback();
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

test("honors Pi ignore files and hidden directories during discovery", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-ignore-");
	const sourceRoot = join(workspace, "skills");
	await writeSkill(sourceRoot, "visible", "visible-skill");
	await writeSkill(sourceRoot, "ignored-git", "ignored-git-skill");
	await writeSkill(sourceRoot, "ignored-general", "ignored-general-skill");
	await writeSkill(sourceRoot, "ignored-fd", "ignored-fd-skill");
	await writeSkill(sourceRoot, "group/keep", "reincluded-skill");
	await writeSkill(sourceRoot, ".hidden", "hidden-skill");
	await writeFile(
		join(sourceRoot, ".gitignore"),
		"ignored-git/\ngroup/*\n!group/keep/\n!group/keep/**\n",
	);
	await writeFile(join(sourceRoot, ".ignore"), "ignored-general/\n");
	await writeFile(join(sourceRoot, ".fdignore"), "ignored-fd/\n");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });

	const source = parseSkillSource(sourceRoot, workspace);
	const visible = await resolver.resolve({ source, selector: "visible-skill" });
	assert.equal(visible.name, "visible-skill");
	await visible.transaction?.rollback();
	const reincluded = await resolver.resolve({ source, selector: "reincluded-skill" });
	assert.equal(reincluded.name, "reincluded-skill");
	await reincluded.transaction?.rollback();
	for (const ignored of [
		"ignored-git-skill",
		"ignored-general-skill",
		"ignored-fd-skill",
		"hidden-skill",
	]) {
		await assert.rejects(() => resolver.resolve({ source, selector: ignored }), /No skill named/);
	}
});

test("continues into nested skills when the root skill is ignored", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-ignored-root-");
	const sourceRoot = await writeSkill(workspace, "source", "root-skill");
	await writeSkill(sourceRoot, "nested", "nested-skill");
	await writeFile(join(sourceRoot, ".gitignore"), "SKILL.md\n!nested/SKILL.md\n");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });

	const source = parseSkillSource(sourceRoot, workspace);
	const result = await resolver.resolve({ source });
	assert.equal(result.name, "nested-skill");
	await result.transaction?.rollback();

	await rm(join(sourceRoot, ".gitignore"));
	const visibleRoot = await resolver.resolve({ source });
	assert.equal(visibleRoot.name, "root-skill");
	await visibleRoot.transaction?.rollback();
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

test("allows a unique selection despite unrelated duplicate names", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-unrelated-duplicate-");
	await writeSkill(workspace, "skills/alpha", "alpha");
	await writeSkill(workspace, "skills/beta-one", "beta");
	await writeSkill(workspace, "skills/beta-two", "beta");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });

	const result = await resolver.resolve({
		source: parseSkillSource("./skills", workspace),
		selector: "alpha",
	});
	assert.equal(result.name, "alpha");
	await result.transaction?.rollback();
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

test("rollback restores the index observed when a concurrent transaction commits", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-concurrent-cache-");
	const skillRoot = await writeSkill(workspace, "source", "concurrent-skill");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(skillRoot, workspace);
	await resolveAndCommit(resolver, { source });

	await writeFile(
		join(skillRoot, "SKILL.md"),
		"---\nname: concurrent-skill\ndescription: Candidate A.\n---\n",
	);
	const candidateA = await resolver.resolve({ source, refresh: true });
	await writeFile(
		join(skillRoot, "SKILL.md"),
		"---\nname: concurrent-skill\ndescription: Candidate B.\n---\n",
	);
	const candidateB = await resolver.resolve({ source, refresh: true });

	await candidateA.transaction?.commit();
	await candidateB.transaction?.commit();
	await candidateB.transaction?.rollback();
	assert.equal((await resolver.resolve({ source })).path, candidateA.path);
});

test("restores a published index when rollback follows failed recovery", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-pending-rollback-");
	const skillRoot = await writeSkill(workspace, "source", "original-skill");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(skillRoot, workspace);
	const original = await resolveAndCommit(resolver, { source });

	await writeFile(
		join(skillRoot, "SKILL.md"),
		"---\nname: candidate-skill\ndescription: Candidate skill.\n---\n",
	);
	const candidate = await resolver.resolve({ source, refresh: true });
	const transaction = candidate.transaction;
	assert.ok(transaction);
	const entryRoot = dirname(dirname(dirname(candidate.path)));
	const displacedRoot = `${entryRoot}-displaced`;
	try {
		await assert.rejects(() =>
			transaction.commit(() => {
				renameSync(entryRoot, displacedRoot);
				writeFileSync(entryRoot, "block cache index recovery");
				throw new Error("activation snapshot failed");
			}),
		);
	} finally {
		rmSync(entryRoot, { force: true });
		renameSync(displacedRoot, entryRoot);
	}

	await transaction.rollback();
	assert.equal((await resolver.resolve({ source })).path, original.path);
	await assert.rejects(() => stat(candidate.path), { code: "ENOENT" });
});

test("keeps failed cache publication invisible to concurrent readers", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-publication-read-");
	const skillRoot = await writeSkill(workspace, "source", "original-skill");
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(skillRoot, workspace);
	const original = await resolveAndCommit(resolver, { source });

	await writeFile(
		join(skillRoot, "SKILL.md"),
		"---\nname: candidate-skill\ndescription: Candidate skill.\n---\n",
	);
	const candidate = await resolver.resolve({ source, refresh: true });
	const transaction = candidate.transaction;
	assert.ok(transaction);
	let concurrentRead: ReturnType<SessionSkillResolver["resolve"]> | undefined;
	await assert.rejects(
		() =>
			transaction.commit(() => {
				concurrentRead = resolver.resolve({ source });
				throw new Error("activation snapshot failed");
			}),
		/activation snapshot failed/,
	);

	assert.ok(concurrentRead);
	const observed = await concurrentRead;
	assert.equal(observed.path, original.path);
	assert.equal(observed.name, original.name);
	await assert.rejects(() => stat(candidate.path), { code: "ENOENT" });
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

test("allows exactly 500 discovered skills and rejects the 501st", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-discovery-limit-");
	const sourceRoot = join(workspace, "skills");
	await Promise.all(
		Array.from({ length: 500 }, (_, index) => {
			const suffix = String(index).padStart(3, "0");
			return writeSkill(sourceRoot, suffix, `skill-${suffix}`);
		}),
	);
	await mkdir(join(sourceRoot, "zzz-empty"));
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });
	const source = parseSkillSource(sourceRoot, workspace);
	const accepted = await resolver.resolve({ source, selector: "skill-000" });
	await accepted.transaction?.rollback();

	await writeSkill(sourceRoot, "zzz-skill", "skill-500");
	await assert.rejects(
		() => resolver.resolve({ source, selector: "skill-000", refresh: true }),
		/exceeds the 500-skill discovery limit/,
	);
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

test("skips symlinks outside the selected skill", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-unrelated-symlink-");
	const sourceRoot = join(workspace, "source");
	await writeSkill(sourceRoot, "selected", "selected-skill");
	const linkedRoot = join(workspace, "linked");
	await writeSkill(linkedRoot, "other", "other-skill");
	await symlink(linkedRoot, join(sourceRoot, "unrelated-link"));
	const resolver = new SessionSkillResolver({ cacheRoot: join(workspace, "cache") });

	const result = await resolver.resolve({ source: parseSkillSource(sourceRoot, workspace) });
	assert.equal(result.name, "selected-skill");
	await result.transaction?.rollback();
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

test("retries GitLab HTTPS authentication failures over SSH", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-gitlab-fallback-");
	const fixture = join(workspace, "fixture");
	await writeSkill(fixture, "demo", "private-skill");
	const repositories: string[] = [];
	const cloneRepository: CloneRepository = async (repository, target) => {
		repositories.push(repository);
		if (repositories.length === 1) {
			throw new GitCommandError("Git clone failed.", "Authentication failed");
		}
		await cp(fixture, target, { recursive: true });
	};
	const resolver = new SessionSkillResolver({
		cacheRoot: join(workspace, "cache"),
		cloneRepository,
	});
	const source = parseSkillSource("https://gitlab.com/group/subgroup/private", workspace);
	const result = await resolver.resolve({ source });
	assert.equal(result.name, "private-skill");
	assert.deepEqual(repositories, [
		"https://gitlab.com/group/subgroup/private.git",
		"git@gitlab.com:group/subgroup/private.git",
	]);
});

test("cancels a same-source resolution without waiting for another materialization", async () => {
	const workspace = await temporaryDirectory("pi-session-skills-queued-cancel-");
	const fixture = join(workspace, "fixture");
	await writeSkill(fixture, "demo", "concurrent-skill");
	let callCount = 0;
	let startFirst!: () => void;
	let startSecond!: () => void;
	let releaseFirst!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		startFirst = resolve;
	});
	const secondStarted = new Promise<void>((resolve) => {
		startSecond = resolve;
	});
	const firstRelease = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const cloneRepository: CloneRepository = async (_repository, target, _ref, signal) => {
		callCount++;
		if (callCount === 1) {
			startFirst();
			await firstRelease;
			await cp(fixture, target, { recursive: true });
			return;
		}
		startSecond();
		await new Promise<void>((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
		});
	};
	const cacheRoot = join(workspace, "cache");
	const resolver = new SessionSkillResolver({ cacheRoot, cloneRepository });
	const source = parseSkillSource("https://example.com/repo.git", workspace);
	const first = resolver.resolve({ source });
	await firstStarted;
	const controller = new AbortController();
	const second = resolver.resolve({ source, signal: controller.signal });
	await secondStarted;
	controller.abort();
	await assert.rejects(() => second, /cancelled/);
	releaseFirst();
	const firstResult = await first;
	await firstResult.transaction?.rollback();
	assert.deepEqual(await readdir(join(cacheRoot, "staging")), []);
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

test("validates skill names against the activation-safe grammar", () => {
	for (const name of ["a", "valid-skill", "skill-123"]) {
		assert.equal(isValidSkillName(name), true);
	}
	for (const name of [
		"",
		"Uppercase",
		"two words",
		"-leading",
		"trailing-",
		"double--hyphen",
		"evil\u001b[31m",
		"a".repeat(65),
	]) {
		assert.equal(isValidSkillName(name), false);
	}
});

test("rejects absolute cross-drive relative results as outside a root", () => {
	assert.equal(isRelativePathInside("child/skill"), true);
	assert.equal(isRelativePathInside("../skill"), false);
	assert.equal(isRelativePathInside("D:\\repo\\skill"), false);
	assert.equal(isRelativePathInside("\\\\server\\share\\skill"), false);
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
