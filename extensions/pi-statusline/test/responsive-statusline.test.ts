import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext, createMockPi } from "../../../test/support.js";
import statusline from "../src/statusline.js";

const suiteAgentDir = mkdtempSync(join(tmpdir(), "pi-statusline-responsive-"));
const previousSuiteAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = suiteAgentDir;
after(() => {
	if (previousSuiteAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousSuiteAgentDir;
	rmSync(suiteAgentDir, { recursive: true, force: true });
});

async function emit(
	events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
	name: string,
	...args: unknown[]
) {
	for (const handler of events.get(name) ?? []) await handler(...args);
}

type FooterFactory = (
	tui: { requestRender(): void },
	theme: { fg(color: string, text: string): string; bold(text: string): string },
	footerData: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		onBranchChange(callback: () => void): () => void;
	},
) => { render(width: number): string[]; dispose(): void };

function createFooter(factory: FooterFactory, branch: string | null = null) {
	return factory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => branch,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
}

test("balanced footer fits common widths and keeps context visible at narrow widths", async () => {
	const mock = createMockPi();
	statusline(mock.pi);
	const context = createMockContext({
		mode: "tui",
		cwd: "/workspace/pi-extensions",
		model: { id: "claude-sonnet-4", provider: "anthropic" },
	});
	await emit(mock.events, "session_start", {}, context.ctx);
	const footer = createFooter(context.footer as FooterFactory, "main");
	try {
		for (const width of [24, 40, 80, 120]) {
			const lines = footer.render(width);
			assert.ok(lines.length > 0);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= width),
				`width ${width}`,
			);
			assert.match(lines[0] ?? "", /ctx/u, `context at width ${width}`);
		}
		const wide = footer.render(120)[0] ?? "";
		assert.match(wide, /sonnet-4/u);
		assert.match(wide, /pi-extensions/u);
		assert.match(wide, /main/u);
		assert.match(wide, /💸/u);
		assert.doesNotMatch(wide, /💤|✅/u);
	} finally {
		footer.dispose();
	}
});

test("statusline activity appears only while streaming or tools are active and resets between sessions", async () => {
	const mock = createMockPi();
	statusline(mock.pi);
	const context = createMockContext({ mode: "tui" });
	await emit(mock.events, "session_start", {}, context.ctx);
	const footer = createFooter(context.footer as FooterFactory);
	try {
		assert.doesNotMatch(footer.render(200)[0] ?? "", /💤|✅|⚙|💭/u);
		await emit(mock.events, "agent_start", {}, context.ctx);
		assert.match(footer.render(200)[0] ?? "", /💭 thinking/u);
		await emit(mock.events, "tool_execution_start", { toolName: "read" }, context.ctx);
		await emit(mock.events, "tool_execution_start", { toolName: "read" }, context.ctx);
		assert.match(footer.render(200)[0] ?? "", /⚙ read×2/u);
		await emit(mock.events, "tool_execution_end", { toolName: "read" }, context.ctx);
		await emit(mock.events, "tool_execution_end", { toolName: "read" }, context.ctx);
		assert.match(footer.render(200)[0] ?? "", /💭 thinking/u);
		await emit(mock.events, "agent_end", {}, context.ctx);
		assert.match(footer.render(200)[0] ?? "", /💭 thinking/u);
		await emit(mock.events, "agent_settled", {}, context.ctx);
		assert.doesNotMatch(footer.render(200)[0] ?? "", /💤|✅|⚙|💭/u);

		await emit(mock.events, "tool_execution_start", { toolName: "write" }, context.ctx);
		await emit(mock.events, "session_shutdown", {}, context.ctx);
		const replacement = createMockContext({ mode: "tui" });
		await emit(mock.events, "session_start", {}, replacement.ctx);
		const replacementFooter = createFooter(replacement.footer as FooterFactory);
		try {
			assert.doesNotMatch(replacementFooter.render(200)[0] ?? "", /write|💤|✅|⚙|💭/u);
			await emit(mock.events, "agent_start", {}, replacement.ctx);
			await emit(mock.events, "session_shutdown", {}, context.ctx);
			await emit(mock.events, "agent_end", {}, context.ctx);
			await emit(mock.events, "agent_settled", {}, context.ctx);
			assert.match(replacementFooter.render(200)[0] ?? "", /💭 thinking/u);
			await emit(mock.events, "agent_settled", {}, replacement.ctx);
			assert.doesNotMatch(replacementFooter.render(200)[0] ?? "", /💤|✅|⚙|💭/u);
		} finally {
			replacementFooter.dispose();
		}
	} finally {
		footer.dispose();
	}
});
