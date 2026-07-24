import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config.js";
import { AsyncRefreshController } from "../src/runtime/refresh-controller.js";
import {
	collectWorkspaceSnapshot,
	parseRuntimeVersion,
	type WorkspaceExec,
} from "../src/runtime/workspace.js";

function config(format: string, document: Record<string, unknown> = {}) {
	return normalizeConfig({ format, ...document }).config;
}

const noExec: WorkspaceExec = async () => {
	throw new Error("unexpected command");
};

test("package metadata is bounded, deterministic, and opt-in", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-package-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", version: "1.2.3" }));
		writeFileSync(join(root, "Cargo.toml"), '[package]\nversion = "9.9.9"\n');
		const snapshot = await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$package"),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.deepEqual(snapshot.modules.package, { source: "package.json", version: "v1.2.3" });

		const unreachable = await collectWorkspaceSnapshot({
			cwd: join(root, "missing"),
			config: config("$model"),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.deepEqual(unreachable.modules, {});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("package parser supports Cargo inheritance and Python metadata without ancestor recursion", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-package-formats-"));
	try {
		const child = join(root, "member");
		mkdirSync(child);
		writeFileSync(join(root, "Cargo.toml"), '[workspace.package]\nversion = "2.4.0"\n');
		writeFileSync(join(child, "Cargo.toml"), "[package]\nversion.workspace = true\n");
		let snapshot = await collectWorkspaceSnapshot({
			cwd: child,
			config: config("$package", { package: { version_format: "release-$raw" } }),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.deepEqual(snapshot.modules.package, {
			source: "Cargo.toml workspace",
			version: "release-2.4.0",
		});

		rmSync(join(child, "Cargo.toml"));
		writeFileSync(join(child, "pyproject.toml"), "[project]\nversion = '3.1.0'\n");
		snapshot = await collectWorkspaceSnapshot({
			cwd: child,
			config: config("$package"),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.deepEqual(snapshot.modules.package, {
			source: "pyproject.toml (PEP 621)",
			version: "v3.1.0",
		});
		writeFileSync(join(child, "pyproject.toml"), "[tool.poetry]\nversion = '4.0.1'\n");
		snapshot = await collectWorkspaceSnapshot({
			cwd: child,
			config: config("$package"),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.deepEqual(snapshot.modules.package, {
			source: "pyproject.toml (Poetry)",
			version: "v4.0.1",
		});

		writeFileSync(
			join(child, "pyproject.toml"),
			"[project]\ndynamic = ['version']\nversion = 'secret'\n",
		);
		snapshot = await collectWorkspaceSnapshot({
			cwd: child,
			config: config("$package"),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.equal(snapshot.modules.package, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("language commands are required by active variables and parsed strictly", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-language-"));
	try {
		writeFileSync(join(root, "package.json"), "{}");
		const calls: Array<[string, string[]]> = [];
		const snapshot = await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$nodejs", { nodejs: { format: "$symbol $version" } }),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: async (command, args) => {
				calls.push([command, args]);
				return { stdout: "v22.1.0\r\n", stderr: "", code: 0, killed: false };
			},
		});
		assert.deepEqual(calls, [["node", ["--version"]]]);
		assert.equal(snapshot.modules.nodejs?.version, "v22.1.0");

		calls.length = 0;
		await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$nodejs", { nodejs: { format: "$symbol" } }),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: async (command, args) => {
				calls.push([command, args]);
				return { stdout: "v22.1.0", stderr: "", code: 0, killed: false };
			},
		});
		assert.deepEqual(calls, []);
		assert.equal(parseRuntimeVersion("nodejs", "banner\nv1.0.0"), undefined);
		assert.equal(parseRuntimeVersion("python", "Python 3.13.1\r\n"), "v3.13.1");
		assert.equal(parseRuntimeVersion("golang", "go version go1.24.0 linux/amd64\n"), "v1.24.0");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("development, deployment, and cloud readers publish only allowlisted local metadata", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-contexts-"));
	try {
		mkdirSync(join(root, ".docker"));
		mkdirSync(join(root, ".config", "gcloud", "configurations"), { recursive: true });
		mkdirSync(join(root, ".aws"));
		writeFileSync(
			join(root, ".docker", "config.json"),
			JSON.stringify({ currentContext: "prod", auths: { registry: { auth: "SECRET" } } }),
		);
		writeFileSync(
			join(root, ".aws", "config"),
			"[profile work]\nregion = eu-west-1\naws_secret_access_key = SENTINEL_SECRET\n",
		);
		writeFileSync(join(root, ".config", "gcloud", "active_config"), "default\n");
		writeFileSync(
			join(root, ".config", "gcloud", "configurations", "config_default"),
			"[core]\naccount = dev@example.test\nproject = project-one\naccess_token = SENTINEL_TOKEN\n",
		);
		const snapshot = await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$docker_context$aws$gcloud"),
			environment: { AWS_PROFILE: "work" },
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.deepEqual(snapshot.modules.docker_context, { context: "prod" });
		assert.deepEqual(snapshot.modules.aws, { profile: "work", region: "eu-west-1" });
		assert.deepEqual(snapshot.modules.gcloud, {
			account: "dev@example.test",
			active: "default",
			domain: "example.test",
			project: "project-one",
		});
		assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|TOKEN|auth/iu);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("execution context rules are fixture-driven and sanitize terminal metadata", async () => {
	const snapshot = await collectWorkspaceSnapshot({
		cwd: "/workspace",
		config: config("$os$container$hostname$username", {
			os: { disabled: false },
			hostname: { aliases: { "build.example": "builder" } },
		}),
		environment: {
			SSH_CONNECTION: "local remote",
			REMOTE_CONTAINERS: "true",
			WSL_DISTRO_NAME: "Ubuntu\u001b]8;;bad\u0007\ud800",
		},
		homeDir: "/home/user",
		platform: "linux",
		hostname: "build.example",
		username: "root",
		exec: noExec,
		fileExists: async () => false,
	});
	assert.equal(snapshot.modules.hostname?.hostname, "builder");
	assert.equal(snapshot.modules.username?.user, "root");
	assert.equal(snapshot.modules.container?.name, "Dev Container");
	assert.equal(JSON.stringify(snapshot).includes(String.fromCharCode(27)), false);
	assert.equal(JSON.stringify(snapshot).includes(String.fromCharCode(7)), false);
	assert.equal(JSON.stringify(snapshot).includes("\\ud800"), false);
});

test("execution fixtures cover macOS, Windows, WSL, Docker, Podman, and contextual users", async () => {
	const run = async (
		platform: NodeJS.Platform,
		environment: Record<string, string | undefined>,
		username: string,
		markers: ReadonlySet<string> = new Set(),
	) =>
		collectWorkspaceSnapshot({
			cwd: "/workspace",
			config: config("$os$container$hostname$username", {
				os: { disabled: false },
				hostname: { ssh_only: false },
			}),
			environment,
			homeDir: "/home/user",
			platform,
			hostname: "fixture.example",
			username,
			exec: noExec,
			fileExists: async (path) => markers.has(path),
			fileSystem: {
				readFile: async (path) =>
					path === "/run/systemd/container" && markers.has(path) ? "systemd-nspawn" : undefined,
			},
		});
	const mac = await run("darwin", {}, "developer");
	assert.equal(mac.modules.os?.type, "macos");
	assert.equal(mac.modules.hostname?.hostname, "fixture");
	assert.equal(mac.modules.username, undefined);
	const windows = await run("win32", {}, "Administrator");
	assert.equal(windows.modules.os?.type, "windows");
	assert.equal(windows.modules.username?.user, "Administrator");
	const wsl = await run("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "developer");
	assert.equal(wsl.modules.os?.type, "wsl");
	assert.equal(wsl.modules.container?.type, "wsl");
	const docker = await run("linux", {}, "developer", new Set(["/.dockerenv"]));
	assert.equal(docker.modules.container?.type, "docker");
	const podman = await run("linux", {}, "developer", new Set(["/run/.containerenv"]));
	assert.equal(podman.modules.container?.type, "podman");
	const systemd = await run("linux", {}, "developer", new Set(["/run/systemd/container"]));
	assert.equal(systemd.modules.container?.name, "systemd-nspawn");
});

test("all language collectors use bounded exact commands and degrade independently", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-languages-all-"));
	try {
		for (const [name, content] of [
			["pyproject.toml", "[project]\nname = 'x'\n"],
			["Cargo.toml", "[package]\nname = 'x'\n"],
			["go.mod", "module example.test/x\n"],
			["bun.lock", ""],
			["deno.json", "{}"],
		] as const)
			writeFileSync(join(root, name), content);
		const outputs: Record<string, string> = {
			python: "Python 3.12.2",
			go: "go version go1.23.4 linux/amd64",
			bun: "1.2.3",
			deno: "deno 2.1.4",
		};
		const calls: string[] = [];
		const snapshot = await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$python$rust$golang$bun$deno", {
				python: { format: "$version" },
				rust: { format: "$version" },
				golang: { format: "$version" },
				bun: { format: "$version" },
				deno: { format: "$version" },
			}),
			environment: { PATH: "" },
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: async (command, args, options) => {
				calls.push(`${command} ${args.join(" ")} ${options.timeout}`);
				if (command === "python")
					return { stdout: outputs.python ?? "", stderr: "", code: 0, killed: false };
				if (command === "go")
					return { stdout: outputs.go ?? "", stderr: "", code: 0, killed: false };
				if (command === "bun")
					return { stdout: outputs.bun ?? "", stderr: "", code: 0, killed: false };
				return { stdout: outputs.deno ?? "", stderr: "", code: 0, killed: false };
			},
		});
		assert.deepEqual(calls, [
			"python --version 2000",
			"go version 2000",
			"bun --version 2000",
			"deno -V 2000",
		]);
		assert.equal(snapshot.modules.python?.version, "v3.12.2");
		assert.equal(snapshot.modules.rust?.version, undefined);
		assert.equal(snapshot.modules.golang?.version, "v1.23.4");
		assert.equal(snapshot.modules.bun?.version, "v1.2.3");
		assert.equal(snapshot.modules.deno?.version, "v2.1.4");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("development environment modules use allowlisted activation data and lazy commands", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-development-"));
	try {
		writeFileSync(join(root, "mise.toml"), "");
		writeFileSync(join(root, ".envrc"), "export SECRET=never-read\n");
		writeFileSync(join(root, "pixi.toml"), "[workspace]\nname = 'demo'\n");
		const calls: string[] = [];
		const snapshot = await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$mise$direnv$conda$pixi$nix_shell$guix_shell", {
				mise: { format: "$health" },
				direnv: { format: "$rc_path$allowed$loaded" },
				pixi: { format: "$version$environment$project_name", show_default_environment: true },
			}),
			environment: {
				CONDA_DEFAULT_ENV: "/envs/work",
				PIXI_ENVIRONMENT_NAME: "default",
				IN_NIX_SHELL: "pure",
				NIX_SHELL_NAME: "dev",
				NIX_SHELL_LEVEL: "2",
				GUIX_ENVIRONMENT: "/gnu/store/profile",
				UNRELATED_SECRET: "SENTINEL_SECRET",
			},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: async (command, args) => {
				calls.push(`${command} ${args.join(" ")}`);
				if (command === "mise")
					return { stdout: "all checks passed", stderr: "", code: 0, killed: false };
				if (command === "direnv")
					return {
						stdout: JSON.stringify({
							foundRC: { path: join(root, ".envrc"), allowed: 1 },
							loadedRC: { path: join(root, ".envrc") },
						}),
						stderr: "",
						code: 0,
						killed: false,
					};
				return { stdout: "pixi 0.41.0", stderr: "", code: 0, killed: false };
			},
		});
		assert.deepEqual(calls, ["mise doctor", "direnv status --json", "pixi --version"]);
		assert.deepEqual(snapshot.modules.mise, { health: "healthy" });
		assert.equal(snapshot.modules.direnv?.allowed, "allowed");
		assert.deepEqual(snapshot.modules.conda, { environment: "work" });
		assert.deepEqual(snapshot.modules.pixi, {
			environment: "default",
			project_name: "demo",
			version: "v0.41.0",
		});
		assert.deepEqual(snapshot.modules.nix_shell, { level: "2", name: "dev", state: "pure" });
		assert.deepEqual(snapshot.modules.guix_shell, { state: "active" });
		assert.doesNotMatch(JSON.stringify(snapshot), /SENTINEL|UNRELATED/iu);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Docker only_with_files suppresses unrelated workspaces", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-docker-detect-"));
	try {
		mkdirSync(join(root, ".docker"));
		writeFileSync(join(root, ".docker", "config.json"), JSON.stringify({ currentContext: "prod" }));
		const input = {
			cwd: root,
			config: config("$docker_context", { docker_context: { only_with_files: true } }),
			environment: { DOCKER_CONFIG: join(root, ".docker") },
			homeDir: root,
			platform: "linux" as const,
			hostname: "host",
			username: "user",
			exec: noExec,
		};
		assert.equal((await collectWorkspaceSnapshot(input)).modules.docker_context, undefined);
		writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
		assert.deepEqual((await collectWorkspaceSnapshot(input)).modules.docker_context, {
			context: "prod",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("kubeconfig and Terraform readers remain local, bounded, and command-lazy", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-deployment-"));
	try {
		mkdirSync(join(root, ".kube"));
		mkdirSync(join(root, ".terraform"));
		writeFileSync(join(root, "main.tf"), "terraform {}\n");
		writeFileSync(join(root, ".terraform", "environment"), "production\n");
		writeFileSync(
			join(root, ".kube", "config"),
			`apiVersion: v1\ncurrent-context: prod\ncontexts:\n  - name: prod\n    context:\n      cluster: cluster-a\n      user: deployer\n      namespace: payments\nclusters:\n  - name: cluster-a\n    cluster:\n      server: https://never-contact.invalid\nusers:\n  - name: deployer\n    user:\n      token: SENTINEL_TOKEN\n`,
		);
		const calls: string[] = [];
		const snapshot = await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$kubernetes$terraform", {
				kubernetes: { context_aliases: { prod: "production" } },
				terraform: { format: "$workspace" },
			}),
			environment: {},
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: async (command, args) => {
				calls.push(`${command} ${args.join(" ")}`);
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		assert.deepEqual(snapshot.modules.kubernetes, {
			cluster: "cluster-a",
			context: "production",
			namespace: "payments",
			user: "deployer",
		});
		assert.deepEqual(snapshot.modules.terraform, { workspace: "production" });
		assert.deepEqual(calls, []);
		assert.doesNotMatch(JSON.stringify(snapshot), /TOKEN|server|never-contact/iu);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Azure and OpenStack readers select metadata while discarding adjacent secrets", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-cloud-all-"));
	try {
		mkdirSync(join(root, ".azure"));
		mkdirSync(join(root, ".config", "openstack"), { recursive: true });
		writeFileSync(
			join(root, ".azure", "azureProfile.json"),
			`\uFEFF${JSON.stringify({ subscriptions: [{ isDefault: true, name: "Production", user: { name: "operator@example.test" }, accessToken: "SENTINEL_TOKEN" }] })}`,
		);
		writeFileSync(
			join(root, ".config", "openstack", "clouds.yaml"),
			`clouds:\n  work:\n    auth:\n      project_name: project-a\n      password: SENTINEL_PASSWORD\n      auth_url: https://secret.invalid\n`,
		);
		const snapshot = await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$azure$openstack", {
				azure: { show_username: true, subscription_aliases: { Production: "prod" } },
				openstack: { project_aliases: { "project-a": "project" } },
			}),
			environment: { OS_CLOUD: "work" },
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.deepEqual(snapshot.modules.azure, {
			subscription: "prod",
			username: "operator@example.test",
		});
		assert.deepEqual(snapshot.modules.openstack, { cloud: "work", project: "project" });
		assert.doesNotMatch(
			JSON.stringify(snapshot),
			/SENTINEL|PASSWORD|TOKEN|auth_url|secret\.invalid/iu,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ordinary local identity stays hidden and periodic refresh retains execution metadata", async () => {
	const base = {
		cwd: "/workspace",
		config: config("$container$hostname$username"),
		environment: {},
		homeDir: "/home/user",
		platform: "linux" as const,
		hostname: "local.example",
		username: "developer",
		exec: noExec,
		fileExists: async () => false,
		fileSystem: { readFile: async () => undefined },
	};
	const initial = await collectWorkspaceSnapshot(base);
	assert.deepEqual(initial.modules, {});
	const contextual = await collectWorkspaceSnapshot({
		...base,
		environment: { SSH_CONNECTION: "remote" },
	});
	assert.equal(contextual.modules.hostname?.hostname, "local");
	assert.equal(contextual.modules.username?.user, "developer");
	const periodic = await collectWorkspaceSnapshot({
		...base,
		reason: "periodic",
		previous: contextual,
	});
	assert.deepEqual(periodic.modules, contextual.modules);
});

test("gcloud selector cannot escape its configuration directory", async () => {
	const reads: string[] = [];
	const snapshot = await collectWorkspaceSnapshot({
		cwd: "/workspace",
		config: config("$gcloud"),
		environment: { CLOUDSDK_ACTIVE_CONFIG_NAME: "../../escape" },
		homeDir: "/home/user",
		platform: "linux",
		hostname: "host",
		username: "user",
		exec: noExec,
		fileSystem: {
			readFile: async (path) => {
				reads.push(path);
				return "[core]\nproject = should-not-load\n";
			},
		},
	});
	assert.equal(snapshot.modules.gcloud, undefined);
	assert.deepEqual(reads, []);
});

test("oversized and malformed metadata files fail empty without leaking source text", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-bounds-"));
	try {
		writeFileSync(join(root, "package.json"), `{"version":"${"x".repeat(70_000)}"}`);
		mkdirSync(join(root, ".aws"));
		writeFileSync(
			join(root, ".aws", "config"),
			"[profile broken\naws_secret_access_key=SENTINEL_SECRET\n",
		);
		const snapshot = await collectWorkspaceSnapshot({
			cwd: root,
			config: config("$package$aws"),
			environment: { AWS_PROFILE: "broken" },
			homeDir: root,
			platform: "linux",
			hostname: "host",
			username: "user",
			exec: noExec,
		});
		assert.equal(snapshot.modules.package, undefined);
		assert.deepEqual(snapshot.modules.aws, { profile: "broken" });
		assert.doesNotMatch(JSON.stringify(snapshot), /SENTINEL|SECRET/iu);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("refresh controller coalesces, suppresses equality, and rejects stale generations", async () => {
	const pending: Array<(value: string) => void> = [];
	const published: string[] = [];
	const controller = new AsyncRefreshController<string, string>({
		read: (_input) => new Promise((resolve) => pending.push(resolve)),
		equal: (left, right) => left === right,
		publish: (value) => published.push(value),
	});
	controller.start(1);
	controller.request("old");
	controller.request("coalesced");
	controller.start(2);
	controller.request("new");
	pending.shift()?.("stale");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pending.length, 1);
	pending.shift()?.("fresh");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(published, ["fresh"]);
	controller.request("same");
	pending.shift()?.("fresh");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(published, ["fresh"]);
	controller.stop();
});
