import assert from "node:assert/strict";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import statusline, {
	contextColor,
	extensionColor,
	formatCount,
	formatToolActivity,
	npmPackageName,
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
	assert.deepEqual(splitExtensionStatusIcon("plain status"), { icon: "🔌", text: "plain status" });
	assert.equal(stripExtensionStatusPrefix("firecrawl", "firecrawl: ready"), "ready");
	assert.equal(simplifyExtensionStatusText("ready, missing (details)"), "✓ ✗");
	assert.equal(extensionColor("codex", "checking"), "accent");
	assert.equal(extensionColor("lsp", "command missing"), "warning");
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
