import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { builtinTool, createMockContext, extensionTool } from "../../../test/support.js";
import type { PlanModeSettings } from "../src/settings.js";
import { showPlanModeSettings } from "../src/settings-menu.js";

async function withSettingsMenu(
	run: (fixture: {
		settingsPath: string;
		tui: ReturnType<typeof createTuiHarness>;
		ctx: ReturnType<typeof createMockContext>["ctx"];
		notifications: ReturnType<typeof createMockContext>["notifications"];
		saved: PlanModeSettings[];
	}) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-menu-"));
	const settingsPath = join(directory, "pi-plan-mode.json");
	const tui = createTuiHarness({ width: 72, rows: 24 });
	const context = createMockContext({
		cwd: directory,
		mode: "tui",
		hasUI: true,
		custom: tui.custom,
	});
	const saved: PlanModeSettings[] = [];
	try {
		await run({ settingsPath, tui, ctx: context.ctx, notifications: context.notifications, saved });
	} finally {
		tui.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

function menuOptions(
	settingsPath: string,
	saved: PlanModeSettings[],
	overrides: Partial<Parameters<typeof showPlanModeSettings>[1]> = {},
) {
	return {
		settingsPath,
		tools: [builtinTool("read"), builtinTool("write"), extensionTool("custom")] as ToolInfo[],
		signal: new AbortController().signal,
		isCurrent: () => true,
		onSaved: (settings: PlanModeSettings) => saved.push(settings),
		...overrides,
	};
}

test("Plan settings show five flat workflow rows without materializing a missing file", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		const frame = tui.render().join("\n");
		assert.match(frame, /Plan Mode Settings/);
		assert.match(frame, /Plan thinking\s+inherit/);
		assert.match(frame, /Plan policy tools\s+Automatic safe built-ins/);
		assert.match(frame, /Plan reinjection\s+Off — conversation history only/);
		assert.match(frame, /Export destination\s+PLAN\.md/);
		assert.match(frame, /Plan mode shortcut\s+none/);
		assert.ok(tui.render(34).every((line) => visibleWidth(line) <= 34));
		await assert.rejects(access(settingsPath));

		tui.press("ctrl+c");
		await running;
		assert.deepEqual(saved, []);
		await assert.rejects(access(settingsPath));
	});
});

test("Plan settings save thinking immediately for the next workflow", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();

		assert.equal(
			(JSON.parse(await readFile(settingsPath, "utf8")) as { thinkingLevel: string }).thinkingLevel,
			"off",
		);
		assert.equal(saved.at(-1)?.thinkingLevel, "off");
		assert.match(tui.render().join("\n"), /Plan thinking\s+off/);
		tui.press("ctrl+c");
		await running;
	});
});

test("Default tools distinguish automatic, explicit empty, user risk, blocked rows, and reset", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		let frame = tui.render().join("\n");
		assert.match(frame, /Default Plan policy allowlist/);
		assert.match(frame, /user risk/i);
		assert.match(frame, /Use automatic safe built-ins/);
		tui.press("tui.select.down");
		assert.match(tui.render().join("\n"), /Blocked by Plan-mode policy/i);
		tui.press("tui.select.up");

		// Automatic selects read. Turning it off creates an explicit empty override.
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.deepEqual(saved.at(-1)?.defaultPlanTools, []);
		assert.deepEqual(
			(JSON.parse(await readFile(settingsPath, "utf8")) as { defaultPlanTools: string[] })
				.defaultPlanTools,
			[],
		);
		tui.press("tui.select.cancel");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Plan policy tools\s+No optional tools/);

		// Reopen and choose the pinned reset action after the three tool rows.
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
		frame = tui.render().join("\n");
		assert.match(frame, /Use automatic safe built-ins/);
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.defaultPlanTools, undefined);
		assert.equal(
			Object.hasOwn(JSON.parse(await readFile(settingsPath, "utf8")), "defaultPlanTools"),
			false,
		);
		tui.press("ctrl+c");
		await running;
	});
});

test("Default tools retain configured names without colliding with settings actions", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		await writeFile(settingsPath, '{"defaultPlanTools":["reset-tools"]}\n');
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
		const frame = tui.render().join("\n");
		assert.match(frame, /reset-tools.*pending registration/is);
		assert.match(frame, /Retained and resolved before the first request/i);
		tui.press("ctrl+c");
		await running;
		assert.deepEqual(
			(JSON.parse(await readFile(settingsPath, "utf8")) as { defaultPlanTools: string[] })
				.defaultPlanTools,
			["reset-tools"],
		);
	});
});

test("Plan reinjection cycles outcomes and export destination saves, previews, resets, and cancels", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.implementationPlanRetention, "clear-after-first-run");
		assert.match(tui.render().join("\n"), /Plan reinjection\s+Through first implementation run/);

		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		const frame = tui.render().join("\n");
		assert.match(frame, /Export destination/i);
		assert.match(frame, /PLAN\.md/);
		assert.match(
			tui.render(240).join("\n"),
			new RegExp(
				settingsPath
					.replace("pi-plan-mode.json", "PLAN.md")
					.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
			),
		);
		tui.type("docs/PLAN.md");
		tui.press("tui.input.submit");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.defaultPlanExportPath, "docs/PLAN.md");
		assert.match(tui.render().join("\n"), /Export destination\s+docs\/PLAN\.md/);

		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.press("tui.input.submit");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.defaultPlanExportPath, undefined);
		assert.match(tui.render().join("\n"), /Export destination\s+PLAN\.md/);

		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.type("cancelled.md");
		tui.press("tui.select.cancel");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.defaultPlanExportPath, undefined);
		tui.press("ctrl+c");
		await running;
	});
});

test("Plan mode shortcut can be set and reset in Settings", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.type("ctrl+shift+p");
		tui.press("tui.input.submit");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.toggleShortcut, "ctrl+shift+p");
		const writtenShortcut = JSON.parse(await readFile(settingsPath, "utf8")) as {
			toggleShortcut?: string;
		};
		assert.equal(writtenShortcut.toggleShortcut, "ctrl+shift+p");
		assert.match(tui.render().join("\n"), /Plan mode shortcut\s+ctrl\+shift\+p/);

		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.press("tui.input.submit");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.toggleShortcut, undefined);
		const resetFile = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		assert.equal(Object.hasOwn(resetFile, "toggleShortcut"), false);
		assert.match(tui.render().join("\n"), /Plan mode shortcut\s+none/);
		tui.press("ctrl+c");
		await running;
	});
});

test("long export previews stay within narrow terminal widths", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const longPath = `plans/${"nested-".repeat(16)}PLAN.md`;
		await writeFile(settingsPath, JSON.stringify({ defaultPlanExportPath: longPath }));
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /nested-/);
		assert.ok(tui.render(26).every((line) => visibleWidth(line) <= 26));
		tui.press("tui.select.cancel");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.press("ctrl+c");
		await running;
	});
});

test("Invalid Plan settings are read-only and save failures roll back displayed values", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, notifications, saved }) => {
		await writeFile(settingsPath, "{mock-sensitive-token");
		let running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		const invalid = tui.render().join("\n");
		assert.match(invalid, /Read only/);
		assert.doesNotMatch(invalid, /mock-sensitive-token/);
		tui.press("ctrl+c");
		await running;
		assert.equal(await readFile(settingsPath, "utf8"), "{mock-sensitive-token");

		await writeFile(settingsPath, '{"defaultPlanExportPath":"bad\\u001bpath"}');
		running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		const controlInvalid = tui.render().join("\n");
		assert.match(controlInvalid, /Read only/);
		assert.doesNotMatch(controlInvalid, /bad.*path/is);
		tui.press("ctrl+c");
		await running;

		await rm(settingsPath);
		running = showPlanModeSettings(
			ctx,
			menuOptions(settingsPath, saved, {
				updateSettings: async () => {
					throw new Error("disk full\u001b]52;c;terminal-payload\u0007");
				},
			}),
		);
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Plan thinking\s+inherit/);
		const message = notifications.at(-1)?.message ?? "";
		assert.match(message, /previous value remains/i);
		assert.equal(
			[...message].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 31 || (code >= 127 && code <= 159);
			}),
			false,
		);
		tui.press("ctrl+c");
		await running;
	});
});

test("RPC Settings changes retention and export destination with the same flat navigation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-rpc-"));
	const settingsPath = join(directory, "pi-plan-mode.json");
	try {
		const rpc = createRpcHarness([
			{
				kind: "select",
				options: [
					"Plan thinking (inherit)",
					"Plan policy tools (Automatic safe built-ins)",
					"Plan reinjection (Off — conversation history only)",
					"Export destination (PLAN.md)",
					"Plan mode shortcut (none)",
					"Back",
				],
				response: "Plan reinjection (Off — conversation history only)",
			},
			{
				kind: "select",
				options: [
					"Plan thinking (inherit)",
					"Plan policy tools (Automatic safe built-ins)",
					"Plan reinjection (Through first implementation run)",
					"Export destination (PLAN.md)",
					"Plan mode shortcut (none)",
					"Back",
				],
				response: "Export destination (PLAN.md)",
			},
			{
				kind: "input",
				placeholder: "PLAN.md",
				response: "rpc/PLAN.md",
			},
			{
				kind: "select",
				options: [
					"Plan thinking (inherit)",
					"Plan policy tools (Automatic safe built-ins)",
					"Plan reinjection (Through first implementation run)",
					"Export destination (rpc/PLAN.md)",
					"Plan mode shortcut (none)",
					"Back",
				],
				response: undefined,
			},
		]);
		const context = createMockContext({ cwd: directory, mode: "rpc", hasUI: true, ...rpc.ui });
		const saved: PlanModeSettings[] = [];
		await showPlanModeSettings(context.ctx, menuOptions(settingsPath, saved));
		rpc.assertConsumed();
		assert.equal(saved.at(-1)?.implementationPlanRetention, "clear-after-first-run");
		assert.equal(saved.at(-1)?.defaultPlanExportPath, "rpc/PLAN.md");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan settings adapt to RPC cancellation and disposal aborts an in-flight save", async () => {
	const rpc = createRpcHarness([
		{
			kind: "select",
			options: [
				"Plan thinking (inherit)",
				"Plan policy tools (Automatic safe built-ins)",
				"Plan reinjection (Off — conversation history only)",
				"Export destination (PLAN.md)",
				"Plan mode shortcut (none)",
				"Back",
			],
			response: undefined,
		},
	]);
	const rpcContext = createMockContext({ mode: "rpc", hasUI: true, ...rpc.ui });
	await showPlanModeSettings(
		rpcContext.ctx,
		menuOptions("/tmp/pi-plan-mode.json", [], { tools: [builtinTool("read")] as ToolInfo[] }),
	);
	rpc.assertConsumed();

	await withSettingsMenu(async ({ settingsPath, tui, ctx, notifications, saved }) => {
		let started!: () => void;
		const saveStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const running = showPlanModeSettings(
			ctx,
			menuOptions(settingsPath, saved, {
				updateSettings: async (_patch, updateOptions) => {
					started();
					const signal = updateOptions?.signal;
					return new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
			}),
		);
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await saveStarted;
		tui.dispose();
		await running;
		assert.deepEqual(saved, []);
		assert.deepEqual(notifications, []);
	});
});
