import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { FleetController, type FleetControllerDependencies } from "../src/fleet-controller.js";
import { FleetTransport } from "../src/transport.js";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest(
	"fake tmux launches a real child endpoint, propagates cwd and launch id, and delivers kickoff",
	async () => {
		const runtimeBase = await mkdtemp("/tmp/pi-fleet-launch-integration-");
		const childCwd = await mkdtemp("/tmp/pi-fleet-child-cwd-");
		const canonicalChildCwd = await realpath(childCwd);
		const fixturePath = compiledFixture("launch-child-fixture.js");
		let child: ChildProcessWithoutNullStreams | undefined;
		const childEvents: Record<string, unknown>[] = [];
		let buffer = "";
		const mock = createMockPi();
		const spawnChild = async (
			options: Parameters<ReturnType<FleetControllerDependencies["createTmux"]>["spawnSplit"]>[0],
		) => {
			child = spawn(process.execPath, [fixturePath], {
				cwd: options.cwd,
				env: {
					...process.env,
					...options.environment,
					PI_FLEET_TEST_BASE: runtimeBase,
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdout.on("data", (chunk) => {
				buffer += String(chunk);
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					childEvents.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
					buffer = buffer.slice(newline + 1);
				}
			});
			return { terminalId: "fake-pane", version: "3.4" };
		};
		const deps: FleetControllerDependencies = {
			createTransport: (options) => new FleetTransport(options),
			createTmux: () => ({
				assertAvailable: async () => "3.4",
				spawnSplit: spawnChild,
			}),
			createGhostty: () => ({
				assertAvailable: async () => "1.3.1",
				spawnSplit: async (options) => ({ ...(await spawnChild(options)), version: "1.3.1" }),
			}),
			createZellij: () => ({
				assertAvailable: async () => "0.44.3",
				spawnSplit: async (options) => ({ ...(await spawnChild(options)), version: "0.44.3" }),
			}),
			resolveInvocation: () => ({ command: "/bin/pi", args: [] }),
			createLauncher: async () => ({
				path: join(runtimeBase, "launcher.sh"),
				command: join(runtimeBase, "launcher.sh"),
				cleanup: async () => undefined,
			}),
			realpath: async () => canonicalChildCwd,
			isDirectory: async () => true,
			now: Date.now,
			randomId: (prefix) => `${prefix}_integration1234`,
			sleep: async (milliseconds, signal) => {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, milliseconds);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
			launchTimeoutMs: 5_000,
			environment: {
				TMUX: "/tmp/tmux-1000/default,1234,0",
				TMUX_PANE: "%7",
			},
			runtimeBaseDirectory: runtimeBase,
		};
		const controller = new FleetController(mock.pi, deps);
		const context = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
		try {
			await controller.sessionStart({ reason: "startup" }, context.ctx);
			const result = await controller.spawn(context.ctx, {
				cwd: canonicalChildCwd,
				name: "Child Integration",
				task: "Run integration task",
			});
			assert.equal(result.sessionId, "child-process");
			assert.equal(result.cwd, canonicalChildCwd);
			assert.equal(result.terminal, "tmux");
			assert.equal(result.terminalVersion, "3.4");
			assert.equal(result.kickoffAccepted, true);
			await waitForChildEvent(
				childEvents,
				(event) =>
					event.type === "ready" &&
					event.cwd === canonicalChildCwd &&
					event.launchId === "launch_integration1234" &&
					event.environmentConsumed === true,
			);
			await waitForChildEvent(
				childEvents,
				(event) =>
					event.type === "message" &&
					(event.message as { text?: string }).text === "Run integration task",
			);
			assert.equal(JSON.stringify(childEvents).includes("pifleet:v1"), false);
			assert.equal(JSON.stringify(childEvents).includes("kickoff_integration1234"), false);
		} finally {
			await controller.sessionShutdown({ reason: "quit" }, context.ctx);
			if (child && child.exitCode === null) {
				child.stdin.write("stop\n");
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("child cleanup timed out")), 2_000);
					child?.once("close", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			if (child && child.exitCode === null) child.kill("SIGKILL");
			const remaining = await findEndpointFiles(runtimeBase);
			assert.deepEqual(remaining, []);
			await rm(runtimeBase, { recursive: true, force: true });
			await rm(childCwd, { recursive: true, force: true });
		}
	},
);

async function waitForChildEvent(
	events: Record<string, unknown>[],
	predicate: (event: Record<string, unknown>) => boolean,
) {
	const deadline = Date.now() + 2_000;
	while (!events.some(predicate)) {
		if (Date.now() >= deadline) {
			assert.fail(`Timed out waiting for child event in ${JSON.stringify(events)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function compiledFixture(name: string): string {
	const testHarnessPath = join(
		process.cwd(),
		"node_modules/.cache/pi-extensions-test/packages/pi-fleet/test",
		name,
	);
	if (existsSync(testHarnessPath)) return testHarnessPath;
	execFileSync(
		process.execPath,
		[
			join(process.cwd(), "node_modules/typescript/bin/tsc"),
			"-p",
			"packages/pi-fleet/tsconfig.process-smoke.json",
		],
		{ stdio: "pipe" },
	);
	return join(process.cwd(), "node_modules/.cache/pi-fleet-process/test", name);
}

async function findEndpointFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		for (const nested of await readdir(join(root, entry.name))) {
			if (nested.endsWith(".json") || nested.endsWith(".sock")) files.push(nested);
		}
	}
	return files.sort();
}
