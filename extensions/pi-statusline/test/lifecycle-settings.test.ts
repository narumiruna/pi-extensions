import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { DEFAULT_STATUSLINE_DOCUMENT } from "../src/settings.js";
import statusline from "../src/statusline.js";

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

function createFooter(factory: FooterFactory) {
	return factory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
}

test("session start creates the concise default statusline settings", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-lifecycle-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const mock = createMockPi();
		statusline(mock.pi);
		const context = createMockContext({ mode: "print" });
		await emit(mock.events, "session_start", {}, context.ctx);
		const path = join(root, "pi-statusline.json");
		assert.equal(existsSync(path), true);
		assert.equal(readFileSync(path, "utf8"), DEFAULT_STATUSLINE_DOCUMENT);
		assert.equal(context.footer, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("palette picker previews the highlighted preset and restores on cancel", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-lifecycle-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(
			join(root, "pi-statusline.json"),
			JSON.stringify({ palettePreset: "sunset", segments: ["model"] }),
		);
		const mock = createMockPi();
		statusline(mock.pi);
		let footer: ReturnType<typeof createFooter> | undefined;
		let preview = "";
		const context = createMockContext({
			mode: "tui",
			model: { id: "claude-sonnet-4", provider: "anthropic" },
			select: async (_title: string, choices: string[]) => choices[0],
			custom: async (factory: (...args: unknown[]) => unknown) => {
				let result: unknown;
				const component = factory(
					{ requestRender() {} },
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					},
					{},
					(value: unknown) => {
						result = value;
					},
				) as { handleInput?(data: string): void };
				component.handleInput?.("\u001b[B");
				preview = footer?.render(200)[0] ?? "";
				component.handleInput?.("\u001b");
				return result;
			},
		});
		await emit(mock.events, "session_start", {}, context.ctx);
		footer = createFooter(context.footer as FooterFactory);
		const before = footer.render(200)[0] ?? "";

		await mock.commands.get("statusline")?.handler("", context.ctx);

		const after = footer.render(200)[0] ?? "";
		assert.match(before, /48;2;255;207;112/u);
		assert.match(preview, /48;2;167;192;128/u);
		assert.equal(after, before);
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("line breaks become separate footer rows", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-lifecycle-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(
			join(root, "pi-statusline.json"),
			JSON.stringify({ segments: ["model", "line_break", "cwd", "line_break", "branch"] }),
		);
		const mock = createMockPi();
		statusline(mock.pi);
		const context = createMockContext({
			mode: "tui",
			cwd: "/workspace/project",
			model: { id: "claude-sonnet-4", provider: "anthropic" },
		});
		await emit(mock.events, "session_start", {}, context.ctx);
		const footer = createFooter(context.footer as FooterFactory);
		const rows = footer.render(200);
		assert.equal(rows.length, 3);
		assert.match(rows[0] ?? "", /sonnet-4/u);
		assert.match(rows[1] ?? "", /project/u);
		assert.match(rows[2] ?? "", /no-git/u);
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("a replacement session reloads JSON settings and uses configured segment text", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-lifecycle-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const path = join(root, "pi-statusline.json");
		writeFileSync(
			path,
			JSON.stringify({ segments: ["model"], segmentText: { model: { prefix: "Model: " } } }),
		);
		const mock = createMockPi();
		statusline(mock.pi);
		const context = createMockContext({
			mode: "tui",
			cwd: "/workspace/project",
			model: { id: "claude-sonnet-4", provider: "anthropic" },
		});
		await emit(mock.events, "session_start", {}, context.ctx);
		let footer = createFooter(context.footer as FooterFactory);
		assert.match(footer.render(200).join("\n"), /Model: sonnet-4/u);
		assert.doesNotMatch(footer.render(200).join("\n"), /project/u);
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);

		writeFileSync(
			path,
			JSON.stringify({ segments: ["cwd"], segmentText: { cwd: { suffix: "!" } } }),
		);
		await emit(mock.events, "session_start", {}, context.ctx);
		footer = createFooter(context.footer as FooterFactory);
		assert.match(footer.render(200).join("\n"), /📁 project!/u);
		assert.doesNotMatch(footer.render(200).join("\n"), /sonnet-4/u);
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
