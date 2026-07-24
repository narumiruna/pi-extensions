import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BUILT_IN_CONFIG } from "../src/config.js";
import {
	buildExtensionStatusIconAliases,
	formatCount,
	formatExtensionStatus,
	prContextFromStatuses,
	renderStatusline,
	type StarshipRuntimeSnapshot,
	shortenModel,
} from "../src/modules/index.js";

const LINK = "\x1b]8;;https://github.com/o/r/pull/123\x07#123\x1b]8;;\x07";

function stripAnsi(value: string): string {
	const escapeSequence = String.fromCharCode(27);
	return value.replace(new RegExp(`${escapeSequence}\\[[0-9;]*m`, "gu"), "");
}

function fixture(overrides: Partial<StarshipRuntimeSnapshot> = {}): StarshipRuntimeSnapshot {
	return {
		cwd: "/work/pi-extensions",
		model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
		thinkingLevel: "high",
		turnCount: 7,
		activeTools: new Map(),
		isStreaming: false,
		lastCompletedTool: "read",
		contextUsage: { percent: 75, tokens: 750, contextWindow: 1000 },
		tokenTotals: { input: 1530, output: 200, cost: 0.1234 },
		gitBranch: "feature",
		gitBranchDetails: { name: "feature", detached: false },
		gitCommit: { hash: "0123456789abcdef", detached: false },
		gitStatus: {
			ahead: 2,
			behind: 1,
			stashed: 0,
			conflicted: 1,
			deleted: 0,
			renamed: 0,
			modified: 4,
			staged: 3,
			typechanged: 0,
			untracked: 5,
			worktreeAdded: 0,
			worktreeDeleted: 0,
			worktreeModified: 4,
			worktreeTypechanged: 0,
			indexAdded: 3,
			indexDeleted: 0,
			indexModified: 0,
			indexTypechanged: 0,
		},
		extensionStatuses: new Map([
			["github-pr", `PR ${LINK}: checks failing (2), approved`],
			["goal", "active"],
		]),
		extensionStatusIconAliases: new Map(),
		now: new Date(2026, 0, 1, 9, 5),
		...overrides,
	};
}

test("built-in modules expose Pi values through the default format", () => {
	const rendered = renderStatusline(BUILT_IN_CONFIG, fixture());
	const plain = stripAnsi(rendered.ansi);
	assert.match(plain, /π/);
	assert.match(plain, /anthropic/);
	assert.match(plain, /sonnet-4/);
	assert.match(plain, /high/);
	assert.match(plain, /pi-extensions/);
	assert.match(plain, /feature/);
	assert.match(plain, /=1 !4 \+3 \?5 ⇕⇡2⇣1/);
	assert.match(plain, /read/);
	assert.match(plain, /75%/);
	assert.match(plain, /↑1\.5k ↓200/);
	assert.match(plain, /\$0\.123/);
	assert.match(plain, /09:05/);
	assert.match(plain, /🎯 active/);
	assert.doesNotMatch(plain, /PR .*checks failing/);
	assert.ok(rendered.consumedExtensionStatusKeys.has("github-pr"));
});

test("git branch consumes github-pr only when its module format references pr", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$git_branch\n$extension_status";
	config.formatAst = [
		{ type: "variable", name: "git_branch" },
		{ type: "text", value: "\n" },
		{ type: "variable", name: "extension_status" },
	];
	config.modules.git_branch.format = "$branch";
	config.modules.git_branch.formatAst = [{ type: "variable", name: "branch" }];
	const rendered = renderStatusline(config, fixture());
	assert.equal(rendered.consumedExtensionStatusKeys.has("github-pr"), false);
	assert.match(rendered.ansi, /checks failing/);
});

test("empty and disabled modules disappear and make conditionals empty", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "($provider)($git_branch)($git_status)($extension_status)";
	config.formatAst = [
		{ type: "conditional", children: [{ type: "variable", name: "provider" }] },
		{ type: "conditional", children: [{ type: "variable", name: "git_branch" }] },
		{ type: "conditional", children: [{ type: "variable", name: "git_status" }] },
		{ type: "conditional", children: [{ type: "variable", name: "extension_status" }] },
	];
	const rendered = renderStatusline(
		config,
		fixture({
			model: undefined,
			gitBranch: null,
			gitBranchDetails: undefined,
			gitStatus: undefined,
			extensionStatuses: new Map(),
		}),
	);
	assert.equal(rendered.ansi, "");

	config.format = "$model$time";
	config.formatAst = [
		{ type: "variable", name: "model" },
		{ type: "variable", name: "time" },
	];
	config.modules.time.disabled = true;
	const onlyModel = renderStatusline(config, fixture());
	assert.equal(
		stripAnsi(onlyModel.ansi),
		onlyModel.modules.model.map((chunk) => chunk.text).join(""),
	);
});

test("module format, symbol, style, and disabled settings apply", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$model";
	config.formatAst = [{ type: "variable", name: "model" }];
	config.modules.model.format = "[$symbol:$model]($style)";
	config.modules.model.formatAst = [
		{
			type: "group",
			children: [
				{ type: "variable", name: "symbol" },
				{ type: "text", value: ":" },
				{ type: "variable", name: "model" },
			],
			style: [{ type: "variable", name: "style" }],
		},
	];
	config.modules.model.symbol = "M";
	config.modules.model.style = "red bold";
	const rendered = renderStatusline(config, fixture()).ansi;
	assert.ok(rendered.includes("\u001b[31;1mM:sonnet-4"));
	config.modules.model.disabled = true;
	assert.equal(renderStatusline(config, fixture()).ansi, "");
});

test("$all expands enabled modules in default order without explicit duplicates", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$model$all";
	config.formatAst = [
		{ type: "variable", name: "model" },
		{ type: "variable", name: "all" },
	];
	const rendered = renderStatusline(config, fixture());
	const modelText = rendered.modules.model.map((chunk) => chunk.text).join("");
	assert.equal(rendered.ansi.split(modelText).length - 1, 1);
	assert.ok(rendered.ansi.indexOf("π") > rendered.ansi.indexOf(modelText));
	assert.match(rendered.ansi, /#7/);
});

test("Starship Git modules expose branch, commit, state, metrics, and detailed status", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$git_branch|$git_commit|$git_state|$git_metrics|$git_status";
	config.formatAst = [
		{ type: "variable", name: "git_branch" },
		{ type: "text", value: "|" },
		{ type: "variable", name: "git_commit" },
		{ type: "text", value: "|" },
		{ type: "variable", name: "git_state" },
		{ type: "text", value: "|" },
		{ type: "variable", name: "git_metrics" },
		{ type: "text", value: "|" },
		{ type: "variable", name: "git_status" },
	];
	config.modules.git_branch.format = "$branch:$remote_name/$remote_branch";
	config.modules.git_branch.formatAst = [
		{ type: "variable", name: "branch" },
		{ type: "text", value: ":" },
		{ type: "variable", name: "remote_name" },
		{ type: "text", value: "/" },
		{ type: "variable", name: "remote_branch" },
	];
	config.modules.git_commit.format = "$hash$tag";
	config.modules.git_commit.formatAst = [
		{ type: "variable", name: "hash" },
		{ type: "variable", name: "tag" },
	];
	config.modules.git_state.format = "$state:$progress_current/$progress_total";
	config.modules.git_state.formatAst = [
		{ type: "variable", name: "state" },
		{ type: "text", value: ":" },
		{ type: "variable", name: "progress_current" },
		{ type: "text", value: "/" },
		{ type: "variable", name: "progress_total" },
	];
	config.modules.git_metrics.disabled = false;
	config.modules.git_metrics.format = "+$added/-$deleted";
	config.modules.git_metrics.formatAst = [
		{ type: "text", value: "+" },
		{ type: "variable", name: "added" },
		{ type: "text", value: "/-" },
		{ type: "variable", name: "deleted" },
	];
	config.modules.git_status.format = "$all_status $ahead_behind";
	config.modules.git_status.formatAst = [
		{ type: "variable", name: "all_status" },
		{ type: "text", value: " " },
		{ type: "variable", name: "ahead_behind" },
	];

	const rendered = stripAnsi(
		renderStatusline(
			config,
			fixture({
				gitBranchDetails: {
					name: "feature/native-git",
					remoteName: "origin",
					remoteBranch: "main",
					detached: true,
				},
				gitCommit: { hash: "0123456789abcdef", tag: "v1.2.3", detached: true },
				gitState: { state: "REBASING", progressCurrent: 3, progressTotal: 10 },
				gitMetrics: { added: 12, deleted: 3 },
			}),
		).ansi,
	);
	assert.equal(
		rendered,
		"feature/native-git:origin/main|0123456 🏷 v1.2.3|REBASING:3/10|+12/-3|=1 !4 +3 ?5 ⇕⇡2⇣1",
	);
});

test("git worktree renders linked worktree values and stays empty for the primary worktree", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$git_worktree";
	config.formatAst = [{ type: "variable", name: "git_worktree" }];
	config.modules.git_worktree.format = "$name:$path";
	config.modules.git_worktree.formatAst = [
		{ type: "variable", name: "name" },
		{ type: "text", value: ":" },
		{ type: "variable", name: "path" },
	];

	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					gitWorktree: {
						name: "pi-extensions-feature",
						path: "/work/pi-extensions-feature",
					},
				}),
			).ansi,
		),
		"pi-extensions-feature:/work/pi-extensions-feature",
	);
	assert.equal(renderStatusline(config, fixture({ gitWorktree: undefined })).ansi, "");
});

test("activity handles parallel active tools, thinking, completed, and idle", () => {
	const text = (runtime: Partial<StarshipRuntimeSnapshot>) => {
		const config = structuredClone(BUILT_IN_CONFIG);
		config.format = "$activity";
		config.formatAst = [{ type: "variable", name: "activity" }];
		return stripAnsi(renderStatusline(config, fixture(runtime)).ansi);
	};
	assert.match(
		text({
			activeTools: new Map([
				["read", 2],
				["bash", 1],
			]),
		}),
		/read×2\+1/,
	);
	assert.match(text({ isStreaming: true, lastCompletedTool: undefined }), /thinking/);
	assert.match(text({ lastCompletedTool: "bash" }), /completed bash/);
	assert.match(text({ lastCompletedTool: undefined }), /idle/);
});

test("extension status icons match arbitrary exact keys and explicit namespace wildcards", () => {
	const aliases = new Map<string, string[]>();

	assert.equal(
		formatExtensionStatus("third_party/key", "running", { "third_party/key": "🧩" }, aliases),
		"🧩 running",
	);
	assert.equal(
		formatExtensionStatus("foo:server", "running", { "foo:*": "🧪", "foo:server": "🖥️" }, aliases),
		"🖥️ running",
	);
	assert.equal(
		formatExtensionStatus(
			"foo:server:worker",
			"running",
			{ "foo:*": "🧪", "foo:server:*": "⚙️" },
			aliases,
		),
		"⚙️ running",
	);
	assert.equal(formatExtensionStatus("foo:worker", "running", { "foo:*": "" }, aliases), "running");
	const packageAliases = buildExtensionStatusIconAliases([{ packageName: "@vendor/pi-foo" }]);
	assert.equal(
		formatExtensionStatus(
			"foo:worker",
			"running",
			{ "foo:*": "WILDCARD", "@vendor/pi-foo": "PACKAGE" },
			packageAliases,
		),
		"WILDCARD running",
	);
	for (const key of ["foo", "foobar", "foo/server"]) {
		assert.equal(formatExtensionStatus(key, "running", { "foo:*": "🧪" }, aliases), "🔌 running");
	}
});

test("extension status icons bridge canonical and legacy sync and retry keys", () => {
	const aliases = new Map<string, string[]>();

	assert.equal(formatExtensionStatus("sync", "pushing", {}, aliases), "🔄 pushing");
	assert.equal(formatExtensionStatus("retry", "retrying", {}, aliases), "🔁 retrying");
	assert.equal(formatExtensionStatus("pisync", "pushing", {}, aliases), "🔄 pushing");
	assert.equal(
		formatExtensionStatus("unknown-error-retry", "retrying", {}, aliases),
		"🔁 retrying",
	);
	assert.equal(
		formatExtensionStatus("sync", "pushing", { pisync: "CUSTOM-SYNC" }, aliases),
		"CUSTOM-SYNC pushing",
	);
	assert.equal(
		formatExtensionStatus("pisync", "pushing", { sync: "NEW-SYNC" }, aliases),
		"NEW-SYNC pushing",
	);
	assert.equal(
		formatExtensionStatus(
			"retry",
			"retrying",
			{ "unknown-error-retry": "CUSTOM-RETRY", retry: "NEW-RETRY" },
			aliases,
		),
		"NEW-RETRY retrying",
	);
});

test("extension status icons honor exact keys, aliases, suppression, defaults, and fallback", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$extension_status";
	config.formatAst = [{ type: "variable", name: "extension_status" }];
	config.extensionStatus.icons = {
		goal: "",
		"@vendor/pi-foo": "🧪",
		fallback: "•",
	};
	const aliases = buildExtensionStatusIconAliases([
		{ packageName: "@vendor/pi-foo", source: "npm:@vendor/pi-foo@1.2.3" },
	]);
	const rendered = renderStatusline(
		config,
		fixture({
			extensionStatuses: new Map([
				["goal", "active"],
				["foo:server", "running"],
				["unknown", "waiting"],
				["toString", "prototype safe"],
			]),
			extensionStatusIconAliases: aliases,
		}),
	).ansi;
	assert.match(rendered, /active/);
	assert.doesNotMatch(rendered, /🎯/);
	assert.match(rendered, /🧪 running/);
	assert.match(rendered, /• waiting/);
	assert.match(rendered, /• prototype safe/);
	assert.doesNotMatch(rendered, /🔌 waiting/);
});

test("format helpers are compact and PR state is actionable", () => {
	assert.equal(formatCount(1530), "1.5k");
	assert.equal(shortenModel("claude-sonnet-4-20250514"), "sonnet-4");
	assert.equal(
		prContextFromStatuses(new Map([["github-pr", `PR ${LINK}: checks failing (2), approved`]])),
		`${LINK} · 2 failing`,
	);
	assert.equal(visibleWidth(LINK), 4);
});
