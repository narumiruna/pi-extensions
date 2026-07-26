import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext, createMockPi } from "../../../test/support.js";
import fileQuoteExtension, {
	appendPendingQuote,
	createFileContextAutocompleteProvider,
	createFileQuote,
	discoverProjectFiles,
	formatPromptWithQuote,
	formatPromptWithQuotes,
	loadProjectTextFile,
} from "../src/file-context.js";
import { FileQuoteExplorer } from "../src/file-context-explorer.js";
import { ProjectFileSearch } from "../src/file-search.js";

async function withTempProject(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-file-context-test-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("discovers bounded project text candidates without traversing ignored directories or symlinks", async () => {
	await withTempProject(async (root) => {
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, "node_modules", "hidden"), { recursive: true });
		await writeFile(join(root, "README.md"), "read me");
		await writeFile(join(root, "src", "main.ts"), "export {};\n");
		await writeFile(join(root, "node_modules", "hidden", "index.js"), "hidden");
		await writeFile(join(root, ".git"), "gitdir: /private/metadata\n");
		await symlink(join(root, "src"), join(root, "linked-src"), "dir");

		assert.deepEqual(await discoverProjectFiles(root), ["README.md", "src/main.ts"]);
		assert.deepEqual(await discoverProjectFiles(root, { maxFiles: 1 }), ["README.md"]);
	});
});

test("loads only bounded regular text files inside the project", async () => {
	await withTempProject(async (root) => {
		await writeFile(join(root, "safe.ts"), "one\ntwo\nthree\n");
		await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(join(root, "large.txt"), "x".repeat(32));
		await writeFile(join(root, "empty.txt"), "");

		assert.deepEqual(await loadProjectTextFile(root, "safe.ts"), {
			path: "safe.ts",
			lines: ["one", "two", "three"],
		});
		assert.deepEqual(await loadProjectTextFile(root, "empty.txt"), {
			path: "empty.txt",
			lines: [],
		});
		await assert.rejects(loadProjectTextFile(root, "../outside.txt"), /outside the project/);
		await assert.rejects(loadProjectTextFile(root, "binary.bin"), /binary/);
		await assert.rejects(
			loadProjectTextFile(root, "large.txt", { maxBytes: 16 }),
			/exceeds 16 bytes/,
		);
	});
});

test("rejects a validated file replaced by a symlink before descriptor open", async () => {
	await withTempProject(async (root) => {
		const outside = await mkdtemp(join(tmpdir(), "pi-file-context-outside-test-"));
		try {
			await writeFile(join(root, "safe.ts"), "inside\n");
			await writeFile(join(outside, "secret.ts"), "outside secret\n");
			await assert.rejects(
				loadProjectTextFile(root, "safe.ts", {
					beforeOpen: async () => {
						await rename(join(root, "safe.ts"), join(root, "original.ts"));
						await symlink(join(outside, "secret.ts"), join(root, "safe.ts"));
					},
				}),
				/safely|changed|symbolic link/i,
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("ranks fuzzy file matches and tolerates typos", () => {
	const files = [
		"file-context.ts-notes/README.md",
		"src/file-context.ts",
		"src/settings.ts",
		"docs/guide.md",
	];

	const search = new ProjectFileSearch(files);
	assert.deepEqual(search.search("  FILE-context.ts  "), [
		"src/file-context.ts",
		"file-context.ts-notes/README.md",
	]);
	assert.deepEqual(search.search("src/settings"), ["src/settings.ts"]);
	assert.deepEqual(search.search("setxings"), ["src/settings.ts"]);
	assert.deepEqual(search.search("zzzzzz"), []);
	assert.deepEqual(search.search("  "), files);
});

test("explorer previews a file, selects a range, and keeps rendered rows width-safe", async () => {
	let result: unknown;
	const tui = {
		terminal: { rows: 12 },
		requestRender() {},
	};
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const keybindings = {
		matches(data: string, key: string) {
			return (
				(data === "up" && key === "tui.select.up") ||
				(data === "down" && key === "tui.select.down") ||
				(data === "enter" && key === "tui.select.confirm") ||
				(data === "tab" && key === "tui.input.tab")
			);
		},
	};
	const explorer = new FileQuoteExplorer({
		tui: tui as never,
		theme: theme as never,
		keybindings: keybindings as never,
		files: ["src/unsafe\u001b[31m.ts"],
		loadFile: async () => ({
			path: "src/unsafe.ts",
			lines: ["first", "second", "third", "fourth"],
		}),
		done: (value) => {
			result = value;
		},
	});

	const fileRows = explorer.render(32);
	assert.ok(fileRows.every((line) => !line.includes("\u001b[31m")));
	assert.ok(fileRows.every((line) => visibleWidth(line) <= 32));
	explorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	explorer.handleInput(" ");
	explorer.handleInput("down");
	explorer.handleInput("down");
	const previewRows = explorer.render(32);
	assert.ok(previewRows.every((line) => visibleWidth(line) <= 32));
	explorer.handleInput("enter");
	assert.deepEqual(result, {
		kind: "quote",
		quote: {
			path: "src/unsafe.ts",
			startLine: 1,
			endLine: 3,
			text: "first\nsecond\nthird",
		},
	});

	result = undefined;
	const directPreviewExplorer = new FileQuoteExplorer({
		tui: tui as never,
		theme: theme as never,
		keybindings: keybindings as never,
		files: ["src/direct.ts"],
		initialPath: "src/direct.ts",
		loadFile: async () => ({ path: "src/direct.ts", lines: ["direct"] }),
		done: (value) => {
			result = value;
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(directPreviewExplorer.render(32).some((line) => line.includes("direct")));
	directPreviewExplorer.handleInput("enter");
	assert.deepEqual(result, {
		kind: "quote",
		quote: { path: "src/direct.ts", startLine: 1, endLine: 1, text: "direct" },
	});

	const referenceExplorer = new FileQuoteExplorer({
		tui: tui as never,
		theme: theme as never,
		keybindings: keybindings as never,
		files: ["src/reference.ts"],
		loadFile: async () => ({ path: "", lines: [] }),
		done: (value) => {
			result = value;
		},
	});
	referenceExplorer.handleInput("tab");
	assert.deepEqual(result, { kind: "reference", path: "src/reference.ts" });

	result = "unchanged";
	const cancelledExplorer = new FileQuoteExplorer({
		tui: tui as never,
		theme: theme as never,
		keybindings: keybindings as never,
		files: ["src/cancelled.ts"],
		loadFile: async () => ({ path: "", lines: [] }),
		done: (value) => {
			result = value;
		},
	});
	cancelledExplorer.handleInput("\u001b");
	assert.equal(result, undefined);
});

test("explorer escapes errors and keeps narrow empty states width-safe", async () => {
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const keybindings = {
		matches(data: string, key: string) {
			return data === "enter" && key === "tui.select.confirm";
		},
	};
	const noMatch = new FileQuoteExplorer({
		tui: tui as never,
		theme: theme as never,
		keybindings: keybindings as never,
		files: ["safe.ts"],
		loadFile: async () => ({ path: "", lines: [] }),
		done() {},
	});
	noMatch.handleInput("z");
	assert.ok(noMatch.render(4).every((line) => visibleWidth(line) <= 4));

	const errorExplorer = new FileQuoteExplorer({
		tui: tui as never,
		theme: theme as never,
		keybindings: keybindings as never,
		files: ["unsafe\u001b[31m.bin"],
		loadFile: async () => {
			throw new Error("Cannot open unsafe\u001b[31m.bin");
		},
		done() {},
	});
	errorExplorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	const errorRows = errorExplorer.render(80);
	assert.ok(errorRows.every((line) => !line.includes("\u001b[31m")));
	assert.ok(errorRows.some((line) => line.includes("\\x1b")));
});

test("explorer shows Git status and provenance and selects changed hunks", async () => {
	let result: unknown;
	const status = {
		code: " M",
		label: "modified (unstaged)",
		staged: false,
		unstaged: true,
		untracked: false,
		conflicted: false,
	};
	const explorer = new FileQuoteExplorer({
		tui: { terminal: { rows: 14 }, requestRender() {} } as never,
		theme: {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		keybindings: {
			matches(data: string, key: string) {
				return data === "enter" && key === "tui.select.confirm";
			},
		} as never,
		files: ["src/changed.ts"],
		loadFile: async () => ({
			path: "src/changed.ts",
			lines: ["one", "changed", "three"],
		}),
		gitContext: {
			project: {
				repositoryRoot: "/repo",
				projectPrefix: "",
				branch: "main",
				head: "abcdef1234567890abcdef1234567890abcdef12",
				dirty: true,
			},
			statuses: new Map([["src/changed.ts", status]]),
			async getFileContext() {
				return {
					status,
					blob: "1234567890abcdef1234567890abcdef12345678",
					hunks: [
						{
							header: "@@ -2 +2 @@",
							oldStart: 2,
							oldCount: 1,
							newStart: 2,
							newCount: 1,
							lines: ["@@ -2 +2 @@", "-two", "+changed"],
							changedLines: [2],
						},
					],
				};
			},
		} as never,
		done: (value) => {
			result = value;
		},
	});

	assert.ok(explorer.render(80).some((line) => line.includes(" M") && line.includes("changed.ts")));
	explorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	const preview = explorer.render(100);
	assert.ok(preview.some((line) => line.includes("main@abcdef123456") && line.includes("dirty")));
	assert.ok(preview.some((line) => line.includes("modified (unstaged)")));
	explorer.handleInput("]");
	assert.ok(explorer.render(100).some((line) => line.includes("~2 tokens")));
	explorer.handleInput("enter");
	assert.deepEqual(result, {
		kind: "quote",
		quote: {
			path: "src/changed.ts",
			startLine: 2,
			endLine: 2,
			text: "changed",
			git: {
				head: "abcdef1234567890abcdef1234567890abcdef12",
				branch: "main",
				status: "modified (unstaged)",
				blob: "1234567890abcdef1234567890abcdef12345678",
				contentSha256: "d67e2e944994496c8d8ec76eed0cf9f09679448d584b532bebf941852a37f5ed",
				source: "worktree",
				base: "HEAD",
			},
		},
	});
});

test("explorer discloses current-line blame and bounded file history", async () => {
	const renders: string[][] = [];
	const explorer = new FileQuoteExplorer({
		tui: { terminal: { rows: 12 }, requestRender() {} } as never,
		theme: {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		keybindings: {
			matches(data: string, key: string) {
				return (
					(data === "enter" && key === "tui.select.confirm") ||
					(data === "down" && key === "tui.select.down")
				);
			},
		} as never,
		files: ["src/history.ts"],
		loadFile: async () => ({ path: "src/history.ts", lines: ["one", "two"] }),
		gitContext: {
			project: {
				repositoryRoot: "/repo",
				projectPrefix: "",
				branch: "main",
				head: "abcdef1234567890abcdef1234567890abcdef12",
				dirty: false,
			},
			statuses: new Map(),
			async getFileContext() {
				return { status: undefined, blob: undefined, hunks: [] };
			},
			async getBlame() {
				return {
					commit: "1234567890abcdef1234567890abcdef12345678",
					author: "Alice",
					authorTime: 1_700_000_000,
					summary: "Explain this line",
					committed: true,
				};
			},
			async getHistory() {
				return [
					{
						commit: "fedcba0987654321fedcba0987654321fedcba09",
						author: "Bob",
						authorTime: Number.MAX_VALUE,
						summary: "Update history file",
					},
				];
			},
		} as never,
		done() {},
	});

	explorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	explorer.handleInput("b");
	await new Promise<void>((resolve) => setImmediate(resolve));
	renders.push(explorer.render(100));
	assert.ok(renders[0].every((line) => visibleWidth(line) <= 100));
	assert.ok(
		renders[0].some((line) => line.includes("Alice") && line.includes("Explain this line")),
	);
	explorer.handleInput("down");
	assert.ok(explorer.render(100).every((line) => !line.includes("Alice")));
	explorer.handleInput("h");
	await new Promise<void>((resolve) => setImmediate(resolve));
	renders.push(explorer.render(100));
	assert.ok(renders[1].every((line) => visibleWidth(line) <= 100));
	assert.ok(renders[1].some((line) => line.includes("File history")));
	assert.ok(renders[1].some((line) => line.includes("unknown-date")));
	assert.ok(
		renders[1].some((line) => line.includes("Bob") && line.includes("Update history file")),
	);
	explorer.handleInput("\u001b");
	assert.ok(explorer.render(100).some((line) => line.includes("src/history.ts")));
});

test("explorer cancellation releases detail loading and empty history stays width-safe", async () => {
	let resolveHistory: ((value: []) => void) | undefined;
	const historyPromise = new Promise<[]>((resolve) => {
		resolveHistory = resolve;
	});
	let loadCalls = 0;
	const explorer = new FileQuoteExplorer({
		tui: { terminal: { rows: 10 }, requestRender() {} } as never,
		theme: {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		keybindings: {
			matches(data: string, key: string) {
				return data === "enter" && key === "tui.select.confirm";
			},
		} as never,
		files: ["src/cancel.ts"],
		loadFile: async () => {
			loadCalls += 1;
			return { path: "src/cancel.ts", lines: ["one"] };
		},
		gitContext: {
			project: {
				repositoryRoot: "/repo",
				projectPrefix: "",
				branch: "main",
				head: "a".repeat(40),
				dirty: false,
			},
			statuses: new Map(),
			async getFileContext() {
				return { status: undefined, blob: undefined, hunks: [] };
			},
			async getHistory() {
				return historyPromise;
			},
		} as never,
		done() {},
	});

	explorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	explorer.handleInput("h");
	explorer.handleInput("\u001b");
	explorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(loadCalls, 2);
	resolveHistory?.([]);
	await new Promise<void>((resolve) => setImmediate(resolve));

	const emptyHistory = new FileQuoteExplorer({
		tui: { terminal: { rows: 10 }, requestRender() {} } as never,
		theme: {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		keybindings: {
			matches(data: string, key: string) {
				return data === "enter" && key === "tui.select.confirm";
			},
		} as never,
		files: ["new.ts"],
		loadFile: async () => ({ path: "new.ts", lines: ["new"] }),
		gitContext: {
			project: {
				repositoryRoot: "/repo",
				projectPrefix: "",
				branch: "main",
				head: "a".repeat(40),
				dirty: true,
			},
			statuses: new Map(),
			async getFileContext() {
				return { status: undefined, blob: undefined, hunks: [] };
			},
			async getHistory() {
				return [];
			},
		} as never,
		done() {},
	});
	emptyHistory.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	emptyHistory.handleInput("h");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(emptyHistory.render(4).every((line) => visibleWidth(line) <= 4));
});

test("explorer loads validated revisions and attaches explicit Git diff context", async () => {
	const project = {
		repositoryRoot: "/repo",
		projectPrefix: "",
		branch: "main",
		head: "abcdef1234567890abcdef1234567890abcdef12",
		dirty: true,
	};
	const hunk = {
		header: "@@ -2 +2 @@",
		oldStart: 2,
		oldCount: 1,
		newStart: 2,
		newCount: 1,
		lines: ["@@ -2 +2 @@", "-two", "+changed"],
		changedLines: [2],
	};
	const results: unknown[] = [];
	const makeExplorer = () =>
		new FileQuoteExplorer({
			tui: { terminal: { rows: 14 }, requestRender() {} } as never,
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as never,
			keybindings: {
				matches(data: string, key: string) {
					return data === "enter" && key === "tui.select.confirm";
				},
			} as never,
			files: ["src/revision.ts"],
			loadFile: async () => ({ path: "src/revision.ts", lines: ["one", "changed"] }),
			gitContext: {
				project,
				statuses: new Map(),
				async getFileContext() {
					return { status: undefined, blob: undefined, hunks: [hunk] };
				},
				async loadRevision(_path: string, revision: string) {
					assert.equal(revision, "HEAD~1");
					return {
						path: "src/revision.ts",
						lines: ["old one", "old two"],
						revision,
						commit: "1111111111111111111111111111111111111111",
						blob: "2222222222222222222222222222222222222222",
					};
				},
			} as never,
			done: (value) => results.push(value),
		});

	const revisionExplorer = makeExplorer();
	revisionExplorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	revisionExplorer.handleInput("r");
	revisionExplorer.handleInput("HEAD~1");
	revisionExplorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	const revisionRows = revisionExplorer.render(100);
	assert.ok(revisionRows.every((line) => visibleWidth(line) <= 100));
	assert.ok(revisionRows.some((line) => line.includes("HEAD~1@111111111111")));
	assert.ok(revisionRows.some((line) => line.includes("old one")));
	revisionExplorer.handleInput("enter");
	assert.equal(
		(results[0] as { quote: { git?: { source: string; revision: string } } }).quote.git?.source,
		"revision",
	);
	assert.equal(
		(results[0] as { quote: { git?: { revision: string } } }).quote.git?.revision,
		"HEAD~1",
	);

	const diffExplorer = makeExplorer();
	diffExplorer.handleInput("enter");
	await new Promise<void>((resolve) => setImmediate(resolve));
	diffExplorer.handleInput("d");
	const diffRows = diffExplorer.render(100);
	assert.ok(diffRows.every((line) => visibleWidth(line) <= 100));
	assert.ok(diffRows.some((line) => line.includes("Git diff")));
	assert.ok(diffRows.some((line) => line.includes("+changed")));
	diffExplorer.handleInput("enter");
	const diffResult = results[1] as {
		quote: {
			startLine: number;
			endLine: number;
			text: string;
			git?: { source: string; base: string };
		};
	};
	assert.equal(diffResult.quote.startLine, 2);
	assert.equal(diffResult.quote.endLine, 2);
	assert.equal(diffResult.quote.text, "@@ -2 +2 @@\n-two\n+changed");
	assert.equal(diffResult.quote.git?.source, "git_diff");
	assert.equal(diffResult.quote.git?.base, "HEAD");
});

test("autocomplete preserves native file completions and adds a quote choice per file", async () => {
	const opened: string[] = [];
	let delegatedItem: unknown;
	const baseSuggestions = {
		prefix: "@src",
		items: [
			{ value: "@src/main.ts", label: "src/main.ts" },
			{ value: "@src/components/", label: "src/components/" },
		],
	};
	const current = {
		async getSuggestions() {
			return baseSuggestions;
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: unknown) {
			delegatedItem = item;
			return { lines, cursorLine, cursorCol };
		},
	};
	const provider = createFileContextAutocompleteProvider(current, (path) => {
		opened.push(path);
	});

	const suggestions = await provider.getSuggestions(["draft @src"], 0, 10, {
		signal: new AbortController().signal,
	});
	assert.deepEqual(suggestions, {
		prefix: "@src",
		items: [
			baseSuggestions.items[0],
			{
				value: "@__pi_file_context_quote_lines__/src%2Fmain.ts",
				label: "Quote lines · src/main.ts",
				description: "Open line-range preview",
			},
			baseSuggestions.items[1],
		],
	});

	const nativeCompletion = provider.applyCompletion(
		["draft @src"],
		0,
		10,
		baseSuggestions.items[0] as never,
		"@src",
	);
	assert.deepEqual(nativeCompletion, { lines: ["draft @src"], cursorLine: 0, cursorCol: 10 });
	assert.equal(delegatedItem, baseSuggestions.items[0]);
	assert.deepEqual(opened, []);

	const quoteCompletion = provider.applyCompletion(
		["draft @src"],
		0,
		10,
		suggestions?.items[1] as never,
		"@src",
	);
	assert.deepEqual(quoteCompletion, { lines: ["draft "], cursorLine: 0, cursorCol: 6 });
	await Promise.resolve();
	assert.deepEqual(opened, ["src/main.ts"]);
});

test("captures an exact normalized line snapshot and formats one focused prompt", () => {
	const quote = createFileQuote("src/runtime.ts", ["zero", "one", "two", "three"], 3, 1);
	assert.deepEqual(quote, {
		path: "src/runtime.ts",
		startLine: 2,
		endLine: 4,
		text: "one\ntwo\nthree",
	});
	assert.throws(() => createFileQuote("large.txt", ["x".repeat(50_001)], 0, 0), /50000 bytes/);
	assert.throws(
		() =>
			createFileQuote(
				"many.txt",
				Array.from({ length: 501 }, () => "x"),
				0,
				500,
			),
		/500 lines/,
	);
	assert.equal(
		formatPromptWithQuote("Why this order?", quote),
		'<user_file_quote path="src/runtime.ts" lines="2-4">\none\ntwo\nthree\n</user_file_quote>\n\nThe user intentionally selected the file excerpt above.\n\nWhy this order?',
	);
});

test("adds deterministic optional Git provenance without changing legacy quote syntax", () => {
	const quote = createFileQuote("src/runtime.ts", ["selected"], 0, 0, {
		head: "a".repeat(40),
		branch: "feature/context",
		status: "modified (unstaged)",
		revision: "HEAD",
		blob: "b".repeat(40),
		source: "worktree",
		base: "HEAD",
	});
	assert.deepEqual(quote.git, {
		head: "a".repeat(40),
		branch: "feature/context",
		status: "modified (unstaged)",
		revision: "HEAD",
		blob: "b".repeat(40),
		contentSha256: "d7cbbb688b2e506c022e95cef8c4f629a29b9b36a6e50324e70dff466dbb95af",
		source: "worktree",
		base: "HEAD",
	});
	assert.equal(
		formatPromptWithQuote("Explain", quote),
		`<user_file_quote path="src/runtime.ts" lines="1-1" git_head="${"a".repeat(40)}" git_branch="feature/context" git_status="modified (unstaged)" git_revision="HEAD" git_blob="${"b".repeat(40)}" content_sha256="d7cbbb688b2e506c022e95cef8c4f629a29b9b36a6e50324e70dff466dbb95af" source="worktree" git_base="HEAD">\nselected\n</user_file_quote>\n\nThe user intentionally selected the file excerpt above.\n\nExplain`,
	);
});

test("accumulates ordered pending quotes within aggregate limits", () => {
	const first = createFileQuote("src/first.ts", ["first"], 0, 0);
	const second = createFileQuote("src/second.ts", ["second"], 0, 0);
	const pending = appendPendingQuote(appendPendingQuote([], first), second);
	assert.deepEqual(pending, [first, second]);
	assert.equal(
		formatPromptWithQuotes("Compare them", pending),
		'<user_file_quote path="src/first.ts" lines="1-1">\nfirst\n</user_file_quote>\n\n<user_file_quote path="src/second.ts" lines="1-1">\nsecond\n</user_file_quote>\n\nThe user intentionally selected the file excerpts above.\n\nCompare them',
	);

	const eight = Array.from({ length: 8 }, (_, index) => ({ ...first, path: `${index}.ts` }));
	assert.throws(() => appendPendingQuote(eight, second), /8 pending quotes/);
	const fiftyKb = { ...first, text: "x".repeat(50_000) };
	assert.doesNotThrow(() => appendPendingQuote([fiftyKb], fiftyKb));
	assert.throws(() => appendPendingQuote([fiftyKb, fiftyKb], first), /100000 bytes/);
});

test("registers a TUI fallback command and injects all pending quotes only once", async () => {
	const mock = createMockPi();
	fileQuoteExtension(mock.pi);
	assert.ok(mock.commands.has("file-context"));
	assert.equal(
		mock.commands.get("file-quote")?.handler,
		mock.commands.get("file-context")?.handler,
	);

	let customFactory: unknown;
	let autocompleteFactory: unknown;
	const widgets = new Map<string, unknown>();
	let quoteIndex = 0;
	const quoteResults = [
		{
			kind: "quote",
			quote: {
				path: "src/example.ts",
				startLine: 1,
				endLine: 1,
				text: "const example = true;",
			},
		},
		{
			kind: "quote",
			quote: {
				path: "test/example.test.ts",
				startLine: 2,
				endLine: 3,
				text: "expect(example)\n  .toBe(true);",
			},
		},
	];
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
			},
			notify() {},
			setWidget(key: string, value: unknown) {
				widgets.set(key, value);
			},
			addAutocompleteProvider(factory: unknown) {
				autocompleteFactory = factory;
			},
			async custom(factory: unknown) {
				customFactory = factory;
				const result = quoteResults[quoteIndex];
				quoteIndex += 1;
				return result;
			},
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	assert.equal(typeof autocompleteFactory, "function");
	await mock.commands.get("file-context")?.handler("", context.ctx);
	await mock.commands.get("file-context")?.handler("", context.ctx);
	assert.equal(typeof customFactory, "function");
	assert.deepEqual(widgets.get("file-context"), [
		"Quotes (2) · ~13 tokens:",
		"• src/example.ts · lines 1-1 · ~6 tokens",
		"• test/example.test.ts · lines 2-3 · ~8 tokens",
	]);

	assert.equal(mock.events.get("input"), undefined);
	assert.notEqual(widgets.get("file-context"), undefined);
	const beforeStart = mock.events.get("before_agent_start")?.[0];
	const injection = await beforeStart?.(
		{ prompt: "/skill:explain Explain this", images: [], systemPrompt: "base" },
		context.ctx,
	);
	assert.deepEqual(injection, {
		message: {
			customType: "file-context-quotes",
			content:
				'<user_file_quote path="src/example.ts" lines="1-1">\nconst example = true;\n</user_file_quote>\n\n<user_file_quote path="test/example.test.ts" lines="2-3">\nexpect(example)\n  .toBe(true);\n</user_file_quote>\n\nThe user intentionally selected the file excerpts above.',
			display: false,
		},
	});
	assert.equal(widgets.get("file-context"), undefined);
	assert.equal(
		await beforeStart?.({ prompt: "Again", systemPrompt: "base" }, context.ctx),
		undefined,
	);
	await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	assert.equal(widgets.get("file-context"), undefined);
});

test("quotes whole-file references and rejects picker results from replaced sessions", async () => {
	const referenceMock = createMockPi();
	fileQuoteExtension(referenceMock.pi);
	const pasted: string[] = [];
	const referenceContext = createMockContext({
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify() {},
			setWidget() {},
			addAutocompleteProvider() {},
			async custom() {
				return { kind: "reference", path: 'docs/my "note".md' };
			},
			pasteToEditor(value: string) {
				pasted.push(value);
			},
		},
	});
	await referenceMock.events.get("session_start")?.[0]?.({}, referenceContext.ctx);
	await referenceMock.commands.get("file-context")?.handler("", referenceContext.ctx);
	assert.deepEqual(pasted, ['@"docs/my \\"note\\".md" ']);

	const staleMock = createMockPi();
	fileQuoteExtension(staleMock.pi);
	let resolvePicker: ((value: unknown) => void) | undefined;
	const picker = new Promise((resolve) => {
		resolvePicker = resolve;
	});
	const oldManager = { getSessionId: () => "old" };
	const newManager = { getSessionId: () => "new" };
	const makeContext = (sessionManager: object, custom: () => Promise<unknown>) =>
		createMockContext({
			mode: "tui",
			hasUI: true,
			cwd: process.cwd(),
			sessionManager,
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				notify() {},
				setWidget() {},
				addAutocompleteProvider() {},
				custom,
				pasteToEditor() {},
			},
		});
	const oldContext = makeContext(oldManager, async () => picker);
	const newContext = makeContext(newManager, async () => undefined);
	await staleMock.events.get("session_start")?.[0]?.({}, oldContext.ctx);
	const command = staleMock.commands.get("file-context")?.handler("", oldContext.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await staleMock.events.get("session_start")?.[0]?.({}, newContext.ctx);
	resolvePicker?.({
		kind: "quote",
		quote: { path: "old.ts", startLine: 1, endLine: 1, text: "old" },
	});
	await command;
	assert.equal(
		await staleMock.events.get("before_agent_start")?.[0]?.(
			{ prompt: "new", systemPrompt: "base" },
			newContext.ctx,
		),
		undefined,
	);
});

test("rejects the fallback command observably outside TUI mode", async () => {
	const mock = createMockPi();
	fileQuoteExtension(mock.pi);
	const rpc = createMockContext({ mode: "rpc", hasUI: true });
	await mock.commands.get("file-context")?.handler("", rpc.ctx);
	assert.match(rpc.notifications[0]?.message ?? "", /interactive TUI/);
	assert.equal(rpc.notifications[0]?.level, "warning");

	const print = createMockContext({ mode: "print", hasUI: false });
	await assert.rejects(async () => {
		await mock.commands.get("file-context")?.handler("", print.ctx);
	}, /interactive TUI/);
	await assert.rejects(async () => {
		await mock.commands.get("file-context")?.handler("unexpected", print.ctx);
	}, /Usage/);
});
