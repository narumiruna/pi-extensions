import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
} from "../../../test/support.js";
import {
	completeSyncArguments,
	parseOptions,
	SYNC_COMMANDS,
	setSyncSetupCompletions,
	usage,
	validateCommandOptions,
} from "../src/command.js";
import {
	loadConfig,
	localConfigPath,
	readLocalConfigObject,
	syncConfigReviewFingerprint,
	updateLocalConfig,
} from "../src/config.js";
import { showFileSelection } from "../src/file-selection.js";
import { withStateDirectoryAccess } from "../src/state-directory.js";
import sync from "../src/sync.js";
import { syncBoth } from "../src/sync-operations.js";
import { BUILT_IN_SYNC_ROOTS, RemoteSelectionMismatchError } from "../src/sync-policy.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

function selectedMultiSelectLabel(lines: readonly string[]) {
	const line = lines.find((candidate) => candidate.startsWith("→ ") || candidate.startsWith("› "));
	return line
		?.slice(2)
		.replace(/^\[(?:x| |-)\]\s+/u, "")
		.split(/\s{2,}/u)[0]
		?.trim();
}

test("sync command catalog and usage document setup-addressing routes", () => {
	assert.ok(SYNC_COMMANDS.some((command) => command.name === "use"));
	assert.match(usage(), /use <setup>/u);
	assert.match(usage(), /Version 1 and version 2 settings are unsupported/u);
	assert.doesNotMatch(usage(), /`profiles`|`targets`|--target/u);
	const readme = readFileSync(`${process.cwd()}/packages/pi-sync/README.md`, "utf8");
	for (const command of SYNC_COMMANDS) {
		assert.match(readme, new RegExp(`\\/sync ${command.name}\\b`, "u"));
	}
	for (const block of readme.matchAll(/```json\n(?<json>[\s\S]*?)\n```/gu)) {
		assert.doesNotThrow(() => JSON.parse(block.groups?.json ?? ""));
	}
});

test("--setup is canonical and --target is rejected by the breaking version 3 route", () => {
	assert.deepEqual(parseOptions(["--setup", "work", "--yes"]), {
		yes: true,
		force: false,
		stale: false,
		silent: false,
		reload: true,
		auto: false,
		setup: "work",
		args: [],
	});
	assert.throws(() => parseOptions(["--target", "work"]), /Unknown sync option: --target/u);
	assert.throws(() => parseOptions(["--setup"]), /requires a sync setup name/u);
	assert.throws(
		() => validateCommandOptions("help", parseOptions(["--setup", "work"])),
		/not supported/u,
	);
	assert.doesNotThrow(() => validateCommandOptions("migrate-state", parseOptions(["--yes"])));
	assert.throws(
		() => validateCommandOptions("migrate-state", parseOptions(["--force"])),
		/not supported/u,
	);
});

test("argument completion retains prior tokens and completes known setup names", () => {
	setSyncSetupCompletions(["home", "work"]);
	assert.ok(completeSyncArguments("")?.some((item) => item.value === "status"));
	assert.ok(completeSyncArguments("status --s")?.some((item) => item.value === "status --setup"));
	assert.ok(
		completeSyncArguments("status --setup w")?.some((item) => item.value === "status --setup work"),
	);
	assert.ok(completeSyncArguments("use h")?.some((item) => item.value === "use home"));
	assert.equal(completeSyncArguments("use home "), null);
});

test("extension registers command and separate startup/shutdown cancellation boundaries", () => {
	const mock = createMockPi();
	sync(mock.pi);
	assert.equal(mock.commands.get("sync")?.description?.includes("storage"), true);
	assert.equal(mock.events.get("session_start")?.length, 1);
	assert.equal(mock.events.get("session_shutdown")?.length, 1);
});

test("session start leaves idle legacy state in place until migration is explicit", async () => {
	await withTempHome(async (agentDir) => {
		const legacy = path.join(agentDir, ".pisync");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(path.join(legacy, "default.state.json"), "state");
		const mock = createMockPi();
		sync(mock.pi);
		const { ctx, notifications } = createMockContext();

		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.equal(readFileSync(path.join(legacy, "default.state.json"), "utf8"), "state");
		assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
		assert.ok(
			notifications.some((notification) =>
				/close other Pi sessions.*migrate-state/iu.test(notification.message),
			),
		);
	});
});

test("explicit migrate-state route moves legacy state after user acknowledgement", async () => {
	await withTempHome(async (agentDir) => {
		const legacy = path.join(agentDir, ".pisync");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(path.join(legacy, "default.state.json"), "state");
		const mock = createMockPi();
		sync(mock.pi);
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });

		await mock.commands.get("sync")?.handler("migrate-state --yes", ctx);

		assert.equal(existsSync(legacy), false);
		assert.equal(
			readFileSync(path.join(agentDir, "pi-sync", "default.state.json"), "utf8"),
			"state",
		);
		assert.ok(
			notifications.some((notification) => /Migrated pi-sync state/u.test(notification.message)),
		);
	});
});

test("migrate-state TUI cancellation leaves legacy state unchanged", async () => {
	await withTempHome(async (agentDir) => {
		const legacy = path.join(agentDir, ".pisync");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(path.join(legacy, "default.state.json"), "state");
		const mock = createMockPi();
		sync(mock.pi);
		const { ctx, notifications } = createMockContext({
			mode: "tui",
			confirm: async () => false,
		});

		await mock.commands.get("sync")?.handler("migrate-state", ctx);

		assert.equal(readFileSync(path.join(legacy, "default.state.json"), "utf8"), "state");
		assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
		assert.ok(
			notifications.some((notification) => /migration cancelled/u.test(notification.message)),
		);
	});
});

test("print and JSON modes reject before relying on no-op UI output", async () => {
	const mock = createMockPi();
	sync(mock.pi);
	const { ctx } = createMockContext({ hasUI: false, mode: "print" });
	const command = mock.commands.get("sync");
	assert.ok(command);
	await assert.rejects(async () => {
		await command.handler("help", ctx);
	}, /requires TUI or RPC mode/u);
});

test("RPC init creates a valid empty version 3 document", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const mock = createMockPi();
		sync(mock.pi);
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
		await mock.commands.get("sync")?.handler("init", ctx);
		assert.deepEqual(await readLocalConfigObject(), {
			version: 3,
			onSwitch: "ask-before-pull",
			skipSecretScan: false,
			storageConnections: {},
			syncSetups: {},
		});
		assert.match(notifications.at(-1)?.message ?? "", /Created/u);
	});
});

test("direct selection mismatch reports exact differences and inline recovery guidance", async () => {
	await withStateDirectory(async () => {
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					pull: async () => {
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json", "AGENTS.md"],
							["AGENTS.md", "models.json"],
						);
					},
				}) as never,
		});
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });

		await mock.commands.get("sync")?.handler("pull --setup home", ctx);

		const message = notifications.at(-1)?.message ?? "";
		assert.match(message, /Remote-only: models\.json/u);
		assert.match(message, /This-device-only: settings\.json/u);
		assert.match(message, /Run \/sync in TUI to review/u);
	});
});

test("direct interactive selection mismatch opens recovery and cancellation preserves attention", async () => {
	await withStateDirectory(async () => {
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const config = await loadConfig("home");
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					pull: async () => {
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json"],
							["settings.json", "models.json"],
							syncConfigReviewFingerprint(config),
						);
					},
				}) as never,
		});
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx, notifications, statuses, widgets } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: tui.custom,
		});

		const running = mock.commands.get("sync")?.handler("pull --setup home", ctx);
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Synced content differs/u);
		tui.press("tui.select.cancel");
		await running;

		assert.deepEqual(notifications, []);
		assert.match(statuses.get("sync") ?? "", /review needed/u);
		assert.ok(widgets.get("sync:attention"));
	});
});

test("direct interactive local-wins recovery clears attention after reviewed publication", async () => {
	await withStateDirectory(async () => {
		mkdirSync(path.dirname(localConfigPath()), { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const config = await loadConfig("home");
		let pushes = 0;
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					pull: async () => {
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json"],
							["settings.json", "models.json"],
							syncConfigReviewFingerprint(config),
						);
					},
					push: async (_ctx: unknown, options: { force?: boolean; yes?: boolean }) => {
						assert.equal(options.force, true);
						assert.equal(options.yes, false);
						pushes += 1;
						return "applied";
					},
				}) as never,
		});
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx, statuses, widgets } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: tui.custom,
		});

		const running = mock.commands.get("sync")?.handler("pull --setup home", ctx);
		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await running;

		assert.equal(pushes, 1);
		assert.equal(statuses.get("sync"), undefined);
		assert.equal(widgets.get("sync:attention"), undefined);
	});
});

test("direct TUI --yes mismatch remains non-interactive but publishes attention", async () => {
	await withStateDirectory(async () => {
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const config = await loadConfig("home");
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					pull: async () => {
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json"],
							["models.json"],
							syncConfigReviewFingerprint(config),
						);
					},
				}) as never,
		});
		let customCalls = 0;
		const { ctx, notifications, statuses } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async () => {
				customCalls += 1;
				return undefined;
			},
		});

		await mock.commands.get("sync")?.handler("pull --yes --setup home", ctx);

		assert.equal(customCalls, 0);
		assert.match(notifications.at(-1)?.message ?? "", /Remote-only: models\.json/u);
		assert.match(statuses.get("sync") ?? "", /review needed/u);
	});
});

test("a successful deterministic force push clears matching attention", async () => {
	await withStateDirectory(async () => {
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const config = await loadConfig("home");
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					pull: async () => {
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json"],
							["settings.json", "models.json"],
							syncConfigReviewFingerprint(config),
						);
					},
					push: async () => "applied",
				}) as never,
		});
		const { ctx, statuses, widgets } = createMockContext({ hasUI: true, mode: "tui" });
		await mock.commands.get("sync")?.handler("pull --yes --setup home", ctx);
		assert.match(statuses.get("sync") ?? "", /review needed/u);

		await mock.commands.get("sync")?.handler("push --force --yes --setup home", ctx);

		assert.equal(statuses.get("sync"), undefined);
		assert.equal(widgets.get("sync:attention"), undefined);
	});
});

test("a later direct command clears attention invalidated by local setup changes", async () => {
	await withStateDirectory(async () => {
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const config = await loadConfig("home");
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					pull: async () => {
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json"],
							["settings.json", "models.json"],
							syncConfigReviewFingerprint(config),
						);
					},
				}) as never,
		});
		const { ctx, statuses, widgets } = createMockContext({ hasUI: true, mode: "tui" });
		await mock.commands.get("sync")?.handler("pull --yes --setup home", ctx);
		assert.match(statuses.get("sync") ?? "", /review needed/u);
		await updateLocalConfig((settings) => ({
			...settings,
			syncSetups: {
				...settings.syncSetups,
				home: {
					...settings.syncSetups.home,
					sync: { ...settings.syncSetups.home.sync, include: ["models.json"] },
				},
			},
		}));

		await mock.commands.get("sync")?.handler("help", ctx);

		assert.equal(statuses.get("sync"), undefined);
		assert.equal(widgets.get("sync:attention"), undefined);
	});
});

test("direct order-only mismatch explains both ordered lists", async () => {
	await withStateDirectory(async () => {
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					push: async () => {
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json", "AGENTS.md"],
							["AGENTS.md", "settings.json"],
						);
					},
				}) as never,
		});
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });

		await mock.commands.get("sync")?.handler("push --setup home", ctx);

		const message = notifications.at(-1)?.message ?? "";
		assert.match(message, /Only ordering differs/u);
		assert.match(message, /Remote order: AGENTS\.md, settings\.json/u);
		assert.match(message, /This device order: settings\.json, AGENTS\.md/u);
	});
});

test("generic operation failures never expose selection resolution actions", async () => {
	await withStateDirectory(async () => {
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					pull: async () => {
						throw new Error("transport authentication failed");
					},
				}) as never,
		});
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });

		await mock.commands.get("sync")?.handler("pull --setup home", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /transport authentication failed/u);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /content list|update remote/iu);
	});
});

test("the command boundary sends only typed selection mismatches to the manager resolver", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		let releaseOperation: () => void = () => undefined;
		const operationGate = new Promise<void>((resolve) => {
			releaseOperation = resolve;
		});
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					syncBoth: async () => {
						await operationGate;
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json"],
							["settings.json", "pi-starship.toml"],
						);
					},
				}) as never,
		});
		const tui = createTuiHarness({ width: 80, rows: 20 });
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: tui.custom,
		});
		const running = mock.commands.get("sync")?.handler("", ctx);

		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		releaseOperation();
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Synced content differs/u);
		assert.match(tui.render().join("\n"), /Remote-only paths: 1/u);
		assert.deepEqual(notifications, []);
		tui.press("tui.select.cancel");
		await tui.waitForOpen();
		tui.press("ctrl+c");
		await running;
	});
});

test("automatic selection mismatch offers immediate TUI recovery and Later preserves attention", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(
			`${JSON.stringify(v3S3Settings({ automatic: true, include: ["settings.json", "sessions"] }))}\n`,
		);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
		writeFileSync(path.join(agentDir, "sessions", "one.jsonl"), "{}\n");
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					syncBoth: async () => {
						throw await selectionMismatch();
					},
					push: async () => {
						throw await selectionMismatch();
					},
				}) as never,
		});
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx, notifications, statuses, widgets } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: tui.custom,
		});

		const starting = mock.events.get("session_start")?.[0]?.({}, ctx);
		await tui.waitForOpen();
		const frame = tui.render().join("\n");
		assert.match(frame, /Synced content differs/u);
		assert.match(frame, /Later/u);
		assert.match(frame, /Remote-only paths: 1/u);
		let concurrentStateAccess = false;
		await withStateDirectoryAccess(async () => {
			concurrentStateAccess = true;
		});
		assert.equal(concurrentStateAccess, true);
		tui.press("tui.select.cancel");
		await starting;

		assert.deepEqual(notifications, []);
		assert.match(statuses.get("sync") ?? "", /review needed/u);
		assert.ok(widgets.get("sync:attention"));
		assert.deepEqual(readFileSync(localConfigPath()), before);

		const manager = mock.commands.get("sync")?.handler("", ctx);
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Review synced content \(recommended\)/u);
		tui.press("ctrl+c");
		await manager;

		let shutdownCustomCalls = 0;
		const shutdown = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async () => {
				shutdownCustomCalls += 1;
				return undefined;
			},
		});
		await mock.events.get("session_shutdown")?.[0]?.({ reason: "exit" }, shutdown.ctx);
		assert.equal(shutdownCustomCalls, 0);
		assert.match(shutdown.notifications.at(-1)?.message ?? "", /session push skipped/u);
		assert.match(shutdown.notifications.at(-1)?.message ?? "", /Remote-only: pi-starship\.toml/u);
		assert.equal(shutdown.widgets.get("sync:attention"), undefined);
		assert.equal(shutdown.statuses.get("sync"), undefined);

		async function selectionMismatch() {
			const config = await loadConfig("home");
			return new RemoteSelectionMismatchError(
				"home",
				["settings.json", "sessions"],
				["settings.json", "pi-starship.toml", "sessions"],
				syncConfigReviewFingerprint(config),
			);
		}
	});
});

test("session replacement aborts startup attention without stale presentation", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })), {
			mode: 0o600,
		});
		const config = await loadConfig("home");
		let syncCalls = 0;
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					syncBoth: async () => {
						syncCalls += 1;
						if (syncCalls === 1) {
							throw new RemoteSelectionMismatchError(
								"home",
								["settings.json"],
								["settings.json", "models.json"],
								syncConfigReviewFingerprint(config),
							);
						}
					},
				}) as never,
		});
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const first = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		const firstStart = mock.events.get("session_start")?.[0]?.({}, first.ctx);
		await tui.waitForOpen();
		let replacementCustomCalls = 0;
		const replacement = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async () => {
				replacementCustomCalls += 1;
				return undefined;
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
		await firstStart;

		assert.equal(syncCalls, 2);
		assert.equal(replacementCustomCalls, 0);
		assert.equal(replacement.widgets.get("sync:attention"), undefined);
		assert.equal(replacement.statuses.get("sync"), undefined);
	});
});

test("automatic RPC selection mismatch remains read-only and observable", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })), {
			mode: 0o600,
		});
		const config = await loadConfig("home");
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					syncBoth: async () => {
						throw new RemoteSelectionMismatchError(
							"home",
							["settings.json"],
							["settings.json", "models.json"],
							syncConfigReviewFingerprint(config),
						);
					},
				}) as never,
		});
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });

		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.match(notifications.at(-1)?.message ?? "", /pi-sync auto sync skipped/u);
		assert.match(notifications.at(-1)?.message ?? "", /Remote-only: models\.json/u);
		assert.match(notifications.at(-1)?.message ?? "", /RPC review is read-only/u);
	});
});

test("generic automatic failure remains notification-only", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })), {
			mode: 0o600,
		});
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () =>
				({
					syncBoth: async () => {
						throw new Error("transport unavailable");
					},
				}) as never,
		});
		let customCalls = 0;
		const { ctx, notifications, widgets } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async () => {
				customCalls += 1;
				return undefined;
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.equal(customCalls, 0);
		assert.match(notifications.at(-1)?.message ?? "", /transport unavailable/u);
		assert.equal(widgets.get("sync:attention"), undefined);
	});
});

test("included-content route has a protocol-safe RPC summary", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
		await showFileSelection(ctx, "home");
		assert.match(notifications.at(-1)?.message ?? "", /sync setup home/u);
		assert.match(notifications.at(-1)?.message ?? "", /include: settings.json/u);
		assert.match(notifications.at(-1)?.message ?? "", /sync\.include/u);
	});
});

test("included-content TUI renders textual state at narrow and wide widths", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const rendered = new Map<number, string[]>();
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				for (const width of [32, 60, 100]) {
					const harness = createCustomSelectorHarness(factory, width);
					rendered.set(width, harness.render());
				}
				const harness = createCustomSelectorHarness(factory, 60);
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home");
		for (const [width, lines] of rendered) {
			assert.ok(lines.length > 0);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(lines.join("\n"), /Included Content|included|excluded/u);
		}
	});
});

test("included-content TUI lists built-in and custom paths exactly once", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		for (const root of BUILT_IN_SYNC_ROOTS) {
			const target = path.join(agentDir, root);
			if (root.includes(".")) writeFileSync(target, "{}\n");
			else mkdirSync(target);
		}
		writeFileSync(path.join(agentDir, "custom.json"), "{}\n");
		const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		let customCalls = 0;
		const labels: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				customCalls += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				for (let index = 0; index < 32; index += 1) {
					const label = selectedMultiSelectLabel(harness.render());
					if (!label || labels.includes(label)) break;
					labels.push(label);
					harness.handleInput("tui.select.down");
				}
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home");
		assert.equal(customCalls, 1);
		assert.deepEqual(labels, [
			...BUILT_IN_SYNC_ROOTS,
			"custom.json",
			"sessions",
			"Add custom path…",
		]);
		assert.deepEqual(readFileSync(localConfigPath()), before);
	});
});

test("included-content TUI adds and saves a custom path that is absent locally", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const remoteOnlyPath = "remote-only.toml";
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => remoteOnlyPath,
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					for (let index = 0; index < 32; index += 1) {
						if (selectedMultiSelectLabel(harness.render()) === "Add custom path…") break;
						harness.handleInput("tui.select.down");
					}
					assert.equal(selectedMultiSelectLabel(harness.render()), "Add custom path…");
					harness.handleInput("tui.select.confirm");
					await Promise.resolve();
				} else if (screen === 2) {
					assert.match(harness.render().join("\n"), /\[x\] remote-only\.toml/u);
					harness.handleInput("tui.select.cancel");
				} else {
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");

		assert.equal(screen, 3);
		assert.equal(existsSync(path.join(agentDir, remoteOnlyPath)), false);
		assert.deepEqual((await readLocalConfigObject())?.syncSetups.home.sync.include, [
			"settings.json",
			remoteOnlyPath,
		]);
		assert.match(notifications.at(-1)?.message ?? "", /Saved included content/u);
	});
});

test("included-content TUI rejects an unsafe absent custom path without changing settings", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => "../outside.toml",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					for (let index = 0; index < BUILT_IN_SYNC_ROOTS.length + 1; index += 1) {
						harness.handleInput("tui.select.down");
					}
					assert.equal(selectedMultiSelectLabel(harness.render()), "Add custom path…");
					harness.handleInput("tui.select.confirm");
					await Promise.resolve();
				} else {
					harness.handleInput("tui.select.cancel");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");

		assert.equal(screen, 2);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.match(notifications.at(-1)?.message ?? "", /safe agent-relative/u);
	});
});

test("included-content custom-path input stops on session replacement", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const controller = new AbortController();
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => {
				controller.abort(new DOMException("Session replaced", "AbortError"));
				return "remote-only.toml";
			},
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				for (let index = 0; index < BUILT_IN_SYNC_ROOTS.length + 1; index += 1) {
					harness.handleInput("tui.select.down");
				}
				assert.equal(selectedMultiSelectLabel(harness.render()), "Add custom path…");
				harness.handleInput("tui.select.confirm");
				await Promise.resolve();
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home", controller.signal);

		assert.equal(screen, 1);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.deepEqual(notifications, []);
	});
});

test("included-content TUI saves a discovered custom path once", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
		writeFileSync(path.join(agentDir, "custom.json"), "{}\n");
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					for (let index = 0; index < BUILT_IN_SYNC_ROOTS.length; index += 1) {
						harness.handleInput("tui.select.down");
					}
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					await Promise.resolve();
				} else if (screen === 2) {
					harness.handleInput("tui.select.cancel");
				} else {
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home");
		assert.equal(screen, 3);
		assert.deepEqual((await readLocalConfigObject())?.syncSetups.home.sync.include, [
			"settings.json",
			"custom.json",
		]);
		assert.match(notifications.at(-1)?.message ?? "", /Saved included content/u);
	});
});

test("included-content save preserves a concurrent include change", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		let editorVisits = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async (title: string) => {
				if (title.includes("Included Content")) {
					editorVisits += 1;
					return editorVisits === 1 ? "settings.json" : undefined;
				}
				await updateLocalConfig((current) => ({
					...current,
					syncSetups: {
						...current.syncSetups,
						home: {
							...current.syncSetups.home,
							sync: { ...current.syncSetups.home.sync, include: ["models.json"] },
						},
					},
				}));
				return "Save changes";
			},
		});
		await showFileSelection(ctx, "home");
		assert.deepEqual((await readLocalConfigObject())?.syncSetups.home.sync.include, [
			"models.json",
		]);
		assert.match(notifications.at(-1)?.message ?? "", /included content changed.*reopen/iu);
	});
});

test("included-content editor disposes on session cancellation without saving", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const controller = new AbortController();
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				controller.abort(new DOMException("Session replaced", "AbortError"));
				harness.dispose();
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home", controller.signal);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.deepEqual(notifications, []);
	});
});

test("an empty include reports no selected content before remote transport", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const settings = v3S3Settings({ include: [] });
		writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
		let fetches = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			fetches += 1;
			throw new Error("unexpected transport");
		};
		try {
			const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
			await syncBoth(ctx, {
				yes: true,
				force: false,
				stale: false,
				silent: false,
				reload: false,
				auto: false,
				args: [],
			});
			assert.equal(fetches, 0);
			assert.match(notifications.at(-1)?.message ?? "", /includes no files/u);
			assert.doesNotMatch(notifications.at(-1)?.message ?? "", /up to date/iu);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("unknown and trailing direct arguments fail observably without changing settings", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const mock = createMockPi();
		sync(mock.pi);
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
		await mock.commands.get("sync")?.handler("status trailing", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Unexpected argument/u);
		assert.deepEqual(readFileSync(localConfigPath()), before);
	});
});

test("unsupported settings pause startup automatic sync and remain unchanged", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const bytes = Buffer.from('{"version":2,"secret":"hidden"}\n');
		writeFileSync(localConfigPath(), bytes, { mode: 0o600 });
		const mock = createMockPi();
		sync(mock.pi);
		const { ctx, notifications } = createMockContext({ hasUI: true, mode: "tui" });
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const output = notifications.map((item) => item.message).join("\n");
		assert.match(output, /auto sync skipped|version 3 is required/u);
		assert.doesNotMatch(output, /hidden/u);
		assert.deepEqual(readFileSync(localConfigPath()), bytes);
	});
});

async function withStateDirectory(run: () => Promise<void>) {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		await run();
	});
}
