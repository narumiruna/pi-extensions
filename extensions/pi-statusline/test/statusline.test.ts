import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import statusline, {
	contextColor,
	extensionColor,
	formatCount,
	formatExtensionStatus,
	formatToolActivity,
	npmPackageName,
	readStatuslineSettings,
	shortenModel,
	simplifyExtensionStatusText,
	splitExtensionStatusIcon,
	stripExtensionStatusPrefix,
} from "../src/statusline.js";

test("statusline registers lifecycle handlers without reading thinking level at load time", () => {
	const mock = createMockPi();
	mock.rawPi.getThinkingLevel = () => {
		throw new Error("should be deferred until session_start");
	};

	assert.doesNotThrow(() => statusline(mock.pi));
	assert.ok(mock.events.has("session_start"));
	assert.ok(mock.events.has("tool_execution_start"));
});

test("formatToolActivity prioritizes active tools, streaming, completed tools, and idle", () => {
	type Runtime = Parameters<typeof formatToolActivity>[0];
	const runtime = (value: Partial<Runtime> & Pick<Runtime, "activeTools" | "isStreaming">) =>
		value as Runtime;

	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map([["read", 2]]), isStreaming: false })),
		"⚙ read×2",
	);
	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map(), isStreaming: true })),
		"💭 thinking",
	);
	assert.equal(
		formatToolActivity(
			runtime({
				activeTools: new Map(),
				isStreaming: false,
				lastCompletedTool: "bash",
			}),
		),
		"✅ bash",
	);
	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map(), isStreaming: false })),
		"💤 idle",
	);
});

test("extension status helpers strip prefixes, icons, and simplify text", () => {
	assert.deepEqual(splitExtensionStatusIcon("🔥 running crawl"), {
		icon: "🔥",
		text: "running crawl",
	});
	assert.deepEqual(splitExtensionStatusIcon("plain status"), { text: "plain status" });
	assert.equal(stripExtensionStatusPrefix("firecrawl", "firecrawl: ready"), "ready");
	assert.equal(simplifyExtensionStatusText("ready, missing (details)"), "✓ ✗");
	assert.equal(extensionColor("codex", "checking"), "accent");
	assert.equal(extensionColor("lsp", "command missing"), "warning");
});

test("statusline settings load extension icon overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-test-"));
	const settingsPath = join(root, "pi-statusline-settings.json");

	assert.deepEqual(readStatuslineSettings(settingsPath), { extensionStatusIcons: {} });

	writeFileSync(
		settingsPath,
		JSON.stringify({ extensionStatusIcons: { goal: "", caffeinate: "☕", bad: 1 } }),
	);
	assert.deepEqual(readStatuslineSettings(settingsPath), {
		extensionStatusIcons: { goal: "", caffeinate: "☕" },
	});

	writeFileSync(settingsPath, "not json");
	assert.deepEqual(readStatuslineSettings(settingsPath), { extensionStatusIcons: {} });
});

test("extension status icons use config, leading emoji, defaults, and fallback", () => {
	const theme = { fg: (_color: string, text: string) => text } as never;
	const config = (extensionStatusIcons: Record<string, string>) => ({ extensionStatusIcons });

	assert.equal(formatExtensionStatus("goal", "active", theme, config({})), "🎯 active");
	assert.equal(
		formatExtensionStatus("github-pr", "PR #123 CI ok", theme, config({})),
		"🔎 PR #123 CI ok",
	);
	assert.equal(
		formatExtensionStatus("caffeinate", "☕ display", theme, config({ caffeinate: "🍵" })),
		"🍵 display",
	);
	assert.equal(formatExtensionStatus("caffeinate", "☕ display", theme, config({})), "☕ display");
	assert.equal(formatExtensionStatus("goal", "active", theme, config({ goal: "" })), "active");
	assert.equal(formatExtensionStatus("unknown", "running", theme, config({})), "🔌 running");
});

test("statusline compact formatting helpers", () => {
	assert.equal(contextColor(undefined), "dim");
	assert.equal(contextColor(75), "warning");
	assert.equal(formatCount(1530), "1.5k");
	assert.equal(formatCount(1_200_000), "1.2m");
	assert.equal(shortenModel("claude-sonnet-20241022"), "sonnet");
	assert.equal(shortenModel("gpt-5.3-codex-latest"), "gpt 5.3-codex");
	assert.equal(npmPackageName("npm:@narumitw/pi-goal@0.4.1"), "@narumitw/pi-goal");
	assert.equal(npmPackageName("npm:typescript@latest"), "typescript");
});
