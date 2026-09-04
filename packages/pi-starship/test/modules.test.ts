import assert from "node:assert/strict";
import { sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { BUILT_IN_CONFIG, normalizeConfig, validateConfigDocument } from "../src/config.js";
import { parseFormat } from "../src/format/formatter.js";
import {
	formatCount,
	formatExtensionStatus,
	renderStatusline,
	type StarshipRuntimeSnapshot,
	shortenModel,
} from "../src/modules/index.js";
import { STARSHIP_PRESETS } from "../src/presets/catalog.js";

const ESC = String.fromCharCode(27);
const LINK = "\x1b]8;;https://github.com/o/r/pull/123\x07#123\x1b]8;;\x07";

function stripAnsi(value: string): string {
	const escapeSequence = String.fromCharCode(27);
	let result = value.replace(new RegExp(`${escapeSequence}\\[[0-9;]*m`, "gu"), "");
	const osc8Prefix = `${escapeSequence}]8;;`;
	const terminator = String.fromCharCode(7);
	while (true) {
		const start = result.indexOf(osc8Prefix);
		if (start === -1) return result;
		const end = result.indexOf(terminator, start + osc8Prefix.length);
		if (end === -1) return result.slice(0, start);
		result = result.slice(0, start) + result.slice(end + terminator.length);
	}
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
		tokenTotals: {
			input: 1530,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.1234,
		},
		usingSubscription: false,
		gitBranch: "feature",
		gitBranchDetails: { name: "feature", detached: false },
		gitCommit: { hash: "0123456789abcdef", detached: false },
		githubPr: {
			number: "123",
			link: LINK,
			state: "open",
			checks: "×2",
			review: "R✓",
			status: "×2",
		},
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
		extensionStatuses: new Map([["goal", "active"]]),
		now: new Date(2026, 0, 1, 9, 5),
		...overrides,
	};
}

test("bundled presets render their promised Pi-native information", () => {
	const plainById = new Map(
		STARSHIP_PRESETS.map((preset) => {
			const loaded = validateConfigDocument(`/presets/${preset.id}.toml`, preset.rawDocument);
			return [preset.id, stripAnsi(renderStatusline(loaded.config, fixture(), 80).ansi)];
		}),
	);
	assert.match(plainById.get("minimal") ?? "", /sonnet-4.*pi-extensions.*feature.*read/u);
	assert.doesNotMatch(plainById.get("minimal") ?? "", /π|75\.0%|09:05/u);
	assert.match(plainById.get("bracketed-segments") ?? "", /\[π\].*\[AI sonnet-4\].*\[09:05\]/u);
	assert.match(plainById.get("catppuccin-powerline") ?? "", /.*.*sonnet-4.*.*/u);
	assert.match(plainById.get("gruvbox-rainbow") ?? "", /.*.*sonnet-4.*.*/u);
	assert.match(plainById.get("jetpack") ?? "", /◄.*read.*◯ 75\.0%.*pi-extensions.*△ feature/u);
	assert.match(plainById.get("nerd-font-symbols") ?? "", /.*󰚩.*󰉋.*.*/u);
	assert.match(plainById.get("no-empty-icons") ?? "", /model sonnet-4.*in \/work\/pi-extensions/u);
	assert.match(
		plainById.get("no-nerd-font") ?? "",
		/✦.*◆ sonnet-4.*⌂ \/work\/pi-extensions.*◴ 09:05/u,
	);
	assert.doesNotMatch(plainById.get("no-runtime-versions") ?? "", /sonnet-4|high/u);
	assert.match(plainById.get("no-runtime-versions") ?? "", /π.*AI.*think.*pi-extensions/u);
	assert.match(plainById.get("pastel-powerline") ?? "", /.*.*sonnet-4.*.*/u);
	assert.match(
		plainById.get("plain-text-symbols") ?? "",
		/pi.*model sonnet-4.*dir \/work\/pi-extensions.*git feature/u,
	);
	assert.match(plainById.get("pure-preset") ?? "", /pi-extensions feature.*\nsonnet-4 high/u);
	assert.match(plainById.get("tokyo-night") ?? "", /░▒▓.*.*sonnet-4.*.*.*󰑮.*󰍛.*/u);
	for (const [id, rendered] of plainById) {
		assert.ok(rendered.length > 0, id);
		assert.doesNotMatch(rendered, /undefined|\$[a-z_]+/u, id);
	}
});

test("built-in root renders exactly the reachable nine module categories without backgrounds", () => {
	const rendered = renderStatusline(BUILT_IN_CONFIG, fixture());
	const plain = stripAnsi(rendered.ansi);
	for (const expected of [
		/π/u,
		/sonnet-4/u,
		/high/u,
		/pi-extensions/u,
		/feature/u,
		/=1 !4 \+3 \?5 ⇕⇡2⇣1/u,
		/read/u,
		/75\.0%/u,
		/09:05/u,
	]) {
		assert.match(plain, expected);
	}
	for (const omitted of [/anthropic/u, /PR #123/u, /↑1\.5k/u, /\$0\.123/u, /🔌 active/u]) {
		assert.doesNotMatch(plain, omitted);
	}
	assert.ok(rendered.chunks.every((chunk) => chunk.style?.background === undefined));
});

test("thinking level styles override the compatible module fallback", () => {
	const { config, diagnostics } = normalizeConfig({
		format: "$thinking",
		thinking: {
			format: "[$level]($style)",
			style: "fg:#010203 bg:#040506 bold",
			style_high: "italic red",
		},
	});
	assert.deepEqual(diagnostics, []);

	const high = renderStatusline(config, fixture({ thinkingLevel: "high" })).modules.thinking[0];
	assert.deepEqual(high?.style, {
		foreground: { kind: "named", name: "red" },
		italic: true,
	});
	const low = renderStatusline(config, fixture({ thinkingLevel: "low" })).modules.thinking[0];
	assert.deepEqual(low?.style, {
		foreground: { kind: "rgb", red: 1, green: 2, blue: 3 },
		background: { kind: "rgb", red: 4, green: 5, blue: 6 },
		bold: true,
	});
	const future = renderStatusline(config, fixture({ thinkingLevel: "future" })).modules.thinking[0];
	assert.deepEqual(future?.style, low?.style);
});

test("thinking fallback keeps bundled Powerline preset backgrounds and modifiers", () => {
	for (const id of [
		"catppuccin-powerline",
		"gruvbox-rainbow",
		"pastel-powerline",
		"tokyo-night",
	] as const) {
		const preset = STARSHIP_PRESETS.find((candidate) => candidate.id === id);
		assert.ok(preset, id);
		const loaded = validateConfigDocument(`/presets/${id}.toml`, preset.rawDocument);
		const style = renderStatusline(loaded.config, fixture()).modules.thinking[0]?.style;
		assert.notEqual(style?.background, undefined, id);
		assert.equal(style?.bold, true, id);
	}
});

test("provider aliases are exact, empty-capable, and terminal-safe", () => {
	const aliased = normalizeConfig({
		format: "$provider",
		provider: {
			format: "$provider",
			provider_aliases: {
				"openai-codex": "codex\u001b[31m\nsafe",
				anthropic: "",
			},
		},
	}).config;
	assert.equal(
		renderStatusline(aliased, fixture({ model: { provider: "openai-codex", id: "gpt-5.6" } })).ansi,
		"codex safe",
	);
	assert.equal(
		renderStatusline(aliased, fixture({ model: { provider: "anthropic", id: "claude" } })).ansi,
		"",
	);
	assert.equal(
		renderStatusline(
			aliased,
			fixture({ model: { provider: "openai\u001b[31m\nunsafe", id: "gpt-5.6" } }),
		).ansi,
		"openai unsafe",
	);
});

test("context supports native percentage/window precision", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$context";
	config.formatAst = parseFormat(config.format);
	config.modules.context.format = "$percentage/$window";
	config.modules.context.formatAst = parseFormat(config.modules.context.format);
	config.modules.context.display = [{ threshold: 0, style: "bold green", hidden: false }];

	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					contextUsage: { percent: 2.4, tokens: 6528, contextWindow: 272_000 },
				}),
			).ansi,
		),
		"2.4%/272k",
	);
});

test("context display thresholds hide and select the highest matching style", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$context";
	config.formatAst = parseFormat(config.format);
	const renderAt = (percent: number) =>
		renderStatusline(
			config,
			fixture({ contextUsage: { percent, tokens: 100, contextWindow: 1000 } }),
		).ansi;

	assert.equal(renderAt(0), "");
	assert.equal(renderAt(29.999), "");
	assert.ok(renderAt(30).includes(`${ESC}[32;1m`));
	assert.ok(renderAt(59.999).includes(`${ESC}[32;1m`));
	assert.ok(renderAt(60).includes(`${ESC}[33;1m`));
	assert.ok(renderAt(79.999).includes(`${ESC}[33;1m`));
	assert.ok(renderAt(80).includes(`${ESC}[31;1m`));

	config.modules.context.display = [
		{ threshold: 0, style: "green", hidden: false },
		{ threshold: 50, style: "yellow", hidden: false },
		{ threshold: 50, style: "blue", hidden: false },
	];
	assert.ok(renderAt(50).includes(`${ESC}[34m`));
});

test("cost display thresholds hide low values and select yellow then red", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$cost";
	config.formatAst = parseFormat(config.format);
	const renderAt = (cost: number) =>
		renderStatusline(
			config,
			fixture({ tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost } }),
		).ansi;

	assert.equal(renderAt(0), "");
	assert.equal(renderAt(0.999), "");
	assert.ok(renderAt(1).includes(`${ESC}[33;1m`));
	assert.ok(renderAt(4.999).includes(`${ESC}[33;1m`));
	assert.ok(renderAt(5).includes(`${ESC}[31;1m`));
});

test("git metrics render additions and deletions with independent styles", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$git_metrics";
	config.formatAst = parseFormat(config.format);
	config.modules.git_metrics.disabled = false;
	const runtime = fixture({ gitMetrics: { added: 12, deleted: 3 } });
	const rendered = renderStatusline(config, runtime).ansi;
	assert.ok(rendered.includes(`${ESC}[32;1m+12`));
	assert.ok(rendered.includes(`${ESC}[31;1m-3`));

	config.modules.git_metrics.styles.added_style = "blue";
	config.modules.git_metrics.styles.deleted_style = "yellow";
	const custom = renderStatusline(config, runtime).ansi;
	assert.ok(custom.includes(`${ESC}[34m+12`));
	assert.ok(custom.includes(`${ESC}[33m-3`));
});

test("username selects user and root styles without exposing private selector metadata", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$username";
	config.formatAst = parseFormat(config.format);
	config.modules.username.format = "[$user]($style)$__pi_style_selector";
	config.modules.username.formatAst = parseFormat(config.modules.username.format);
	const renderUser = (selector: "user" | "root") =>
		renderStatusline(
			config,
			fixture({
				workspace: {
					modules: { username: { user: selector === "root" ? "root" : "alice" } },
					styleSelectors: { username: selector },
				},
			}),
		).ansi;

	assert.ok(renderUser("user").startsWith(`${ESC}[33;1malice`));
	assert.ok(renderUser("root").startsWith(`${ESC}[31;1mroot`));
	assert.doesNotMatch(stripAnsi(renderUser("root")), /selector/u);

	config.modules.username.styles.style_root = "bright-purple";
	assert.ok(renderUser("root").startsWith(`${ESC}[95mroot`));
});

test("cache and subscription modules expose native usage semantics", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$cache|$cost";
	config.formatAst = parseFormat(config.format);
	config.modules.cache.disabled = false;
	config.modules.cost.display = [{ threshold: 0, style: "bold yellow", hidden: false }];
	const runtime = fixture({
		tokenTotals: {
			input: 100,
			output: 20,
			cacheRead: 2300,
			cacheWrite: 1500,
			cost: 0.1234,
			latestCacheHitRate: 87.5,
		},
		usingSubscription: true,
	});

	assert.match(
		stripAnsi(renderStatusline(config, runtime).ansi),
		/📦 CH87\.5% \| 💸 \$0\.123 \(sub\) /u,
	);

	config.modules.cache.format = "$read/$write/$rate";
	config.modules.cache.formatAst = parseFormat(config.modules.cache.format);
	assert.match(stripAnsi(renderStatusline(config, runtime).ansi), /^2\.3k\/1\.5k\/87\.5%\|/u);

	config.modules.cache.format = "[$symbol:$rate]($style)";
	config.modules.cache.formatAst = parseFormat(config.modules.cache.format);
	config.modules.cache.symbol = "C";
	config.modules.cache.style = "red";
	assert.ok(
		renderStatusline(config, runtime).ansi.includes(`${String.fromCharCode(27)}[31mC:87.5%`),
	);

	assert.equal(
		renderStatusline(
			config,
			fixture({
				tokenTotals: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					latestCacheHitRate: 0,
				},
				usingSubscription: false,
			}),
		).modules.cache.length,
		0,
	);

	config.format = "$cost";
	config.formatAst = parseFormat(config.format);
	assert.match(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					tokenTotals: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
					},
					usingSubscription: true,
				}),
			).ansi,
		),
		/\$0\.000 \(sub\)/u,
	);
});

test("cache read and write remain available when the latest rate is unknown", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$cache";
	config.formatAst = parseFormat(config.format);
	config.modules.cache.disabled = false;
	config.modules.cache.format = "$symbol:$read/$write/$rate";
	config.modules.cache.formatAst = parseFormat(config.modules.cache.format);
	config.modules.cache.symbol = "C";

	const runtime = fixture({
		tokenTotals: {
			input: 100,
			output: 20,
			cacheRead: 2300,
			cacheWrite: 1500,
			cost: 0.1,
			latestCacheHitRate: undefined,
		},
	});
	assert.equal(stripAnsi(renderStatusline(config, runtime).ansi), "C:2.3k/1.5k/");

	config.modules.cache.format = BUILT_IN_CONFIG.modules.cache.format;
	config.modules.cache.formatAst = parseFormat(config.modules.cache.format);
	assert.equal(stripAnsi(renderStatusline(config, runtime).ansi).trim(), "C");
});

test("external github-pr statuses remain generic extension statuses", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$extension_status";
	config.formatAst = [{ type: "variable", name: "extension_status" }];
	const rendered = stripAnsi(
		renderStatusline(
			config,
			fixture({
				githubPr: undefined,
				extensionStatuses: new Map([["github-pr", `PR ${LINK}: checks failing (2), approved`]]),
			}),
		).ansi,
	);
	assert.match(rendered, /🔌 PR/u);
	assert.match(rendered, /checks failing/u);
	assert.doesNotMatch(rendered, /🔎/u);
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
	config.modules.model.style = "bold bg:#86BBD8";
	assert.ok(renderStatusline(config, fixture()).ansi.includes("\u001b[48;2;134;187;216;1m"));
	config.modules.model.disabled = true;
	assert.equal(renderStatusline(config, fixture()).ansi, "");
});

test("model truncation keeps the configured portions after built-in shortening", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$model";
	config.formatAst = [{ type: "variable", name: "model" }];
	config.modules.model.format = "$model";
	config.modules.model.formatAst = [{ type: "variable", name: "model" }];
	config.modules.model.options.truncation_length = 6;

	const renderModel = (id: string) =>
		stripAnsi(renderStatusline(config, fixture({ model: { provider: "llama.cpp", id } })).ansi);

	config.modules.model.options.truncation_direction = "end";
	assert.equal(renderModel("abcdefghijklmno"), "abcdef…");
	config.modules.model.options.truncation_direction = "start";
	assert.equal(renderModel("abcdefghijklmno"), "…jklmno");
	config.modules.model.options.truncation_direction = "middle";
	assert.equal(renderModel("abcdefghijklmno"), "abc…mno");
	config.modules.model.options.truncation_length = 5;
	assert.equal(renderModel("abcdefghijklmno"), "abc…no");

	config.modules.model.options.truncation_length = 6;
	config.modules.model.options.truncation_symbol = "";
	assert.equal(renderModel("abcdefghijklmno"), "abcmno");
	config.modules.model.options.truncation_length = 0;
	assert.equal(renderModel("abcdefghijklmno"), "abcdefghijklmno");

	config.modules.model.options.truncation_length = 6;
	config.modules.model.options.truncation_symbol = "…";
	config.modules.model.options.truncation_direction = "end";
	assert.equal(renderModel("claude-sonnet-20241022"), "sonnet");
	assert.equal(renderModel("A👨‍👩‍👧‍👦BCDEFG"), "A👨‍👩‍👧‍👦BCDE…");

	const model = { provider: "llama.cpp", id: "ggml-org/gemma-4-E2B-it-GGUF:Q8_0" };
	renderStatusline(config, fixture({ model }));
	assert.equal(model.id, "ggml-org/gemma-4-E2B-it-GGUF:Q8_0");
});

test("model rendering strips terminal sequences from runtime IDs and truncation symbols", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$model";
	config.formatAst = [{ type: "variable", name: "model" }];
	config.modules.model.format = "$model";
	config.modules.model.formatAst = [{ type: "variable", name: "model" }];
	config.modules.model.options.truncation_length = 0;
	const renderModel = (id: string) =>
		renderStatusline(config, fixture({ model: { provider: "llama.cpp", id } })).ansi;

	assert.equal(
		renderModel("safe\x1b]8;;https://evil.example\x07click\x1b]8;;\x07\nmodel"),
		"safeclick model",
	);
	assert.equal(renderModel("a\u009d0;title\u009cb"), "ab");
	assert.equal(renderModel("safe\x1bPpayload\x1b\\model\u202e"), "safemodel");

	config.modules.model.options.truncation_length = 3;
	config.modules.model.options.truncation_symbol = "\x1b[31m!\x1b[0m";
	assert.equal(renderModel("abcdef"), "abc!");
	config.modules.model.options.truncation_symbol = "\x1b_private\x1b\\!\u2066";
	assert.equal(renderModel("abcdef"), "abc!");
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

test("directory applies Starship home, repository, substitution, and component defaults", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$directory";
	config.formatAst = parseFormat(config.format);
	config.modules.directory.format = "$path|$full_path";
	config.modules.directory.formatAst = parseFormat(config.modules.directory.format);

	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					cwd: "/home/alice/work/repository/src/lib/deep",
					homeDir: "/home/alice",
					gitRoot: "/home/alice/work/repository",
				}),
			).ansi,
		),
		"src/lib/deep|/home/alice/work/repository/src/lib/deep",
	);

	config.modules.directory.options.substitutions = {
		"/home/alice/work/repository": "absolute replacement does not match",
	};
	config.modules.directory.options.truncation_length = 0;
	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					cwd: "/home/alice/work/repository/src",
					homeDir: "/home/alice",
					gitRoot: "/home/alice/work/repository",
				}),
			).ansi,
		),
		"repository/src|/home/alice/work/repository/src",
	);

	config.modules.directory.options.substitutions = { repository: "repo" };
	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					cwd: "/home/alice/work/repository/src",
					homeDir: "/home/alice",
					gitRoot: "/home/alice/work/repository",
				}),
			).ansi,
		),
		"repo/src|/home/alice/work/repository/src",
	);

	config.modules.directory.options.truncate_to_repo = false;
	config.modules.directory.options.truncation_length = 2;
	config.modules.directory.options.truncation_symbol = "…/";
	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({ cwd: "/home/alice/work/repository/src", homeDir: "/home/alice" }),
			).ansi,
		),
		"…/repo/src|/home/alice/work/repository/src",
	);

	config.modules.directory.options.substitutions = {};
	config.modules.directory.options.fish_style_pwd_dir_length = 1;
	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({ cwd: "/home/alice/built/this/city", homeDir: "/home/alice" }),
			).ansi,
		),
		"~/b/this/city|/home/alice/built/this/city",
	);
});

test("directory normalizes equivalent roots before contraction", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$directory";
	config.formatAst = parseFormat(config.format);
	config.modules.directory.format = "$path";
	config.modules.directory.formatAst = parseFormat(config.modules.directory.format);
	config.modules.directory.options.truncation_length = 0;

	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({ cwd: "/repository", homeDir: "/home/alice", gitRoot: "/repository/" }),
			).ansi,
		),
		"repository",
	);
	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({ cwd: "/home/alice", homeDir: "/home/alice", gitRoot: "/home/alice/" }),
			).ansi,
		),
		"~",
	);
});

test("directory preserves POSIX backslashes and strips terminal controls", {
	skip: sep !== "/",
}, () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$directory";
	config.formatAst = parseFormat(config.format);
	config.modules.directory.format = "$path|$full_path";
	config.modules.directory.formatAst = parseFormat(config.modules.directory.format);

	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({ cwd: "/home/alice/team\\name/project", homeDir: "/home/alice" }),
			).ansi,
		),
		"~/team\\name/project|/home/alice/team\\name/project",
	);
	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					cwd: "/home/alice/team\x1b]8;;https://evil.example\x07click\x1b]8;;\x07/repo\nline",
					homeDir: "/home/alice",
				}),
			).ansi,
		),
		"~/teamclick/repo line|/home/alice/teamclick/repo line",
	);
	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					cwd: "/home/alice/team/\x1bPhidden\x1b\\repo\u202e",
					homeDir: "/home/alice",
				}),
			).ansi,
		),
		"~/team/repo|/home/alice/team/repo",
	);
});

test("Git branch and commit honor Starship truncation options", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$git_branch|$git_commit";
	config.formatAst = parseFormat(config.format);
	config.modules.git_branch.format = "$branch:$remote_name/$remote_branch";
	config.modules.git_branch.formatAst = parseFormat(config.modules.git_branch.format);
	config.modules.git_branch.options.truncation_length = 4;
	config.modules.git_branch.options.truncation_symbol = "…more";
	config.modules.git_commit.format = "$hash";
	config.modules.git_commit.formatAst = parseFormat(config.modules.git_commit.format);
	config.modules.git_commit.options.commit_hash_length = 10;

	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					gitBranchDetails: {
						name: "feature",
						remoteName: "origin",
						remoteBranch: "remote-main",
						detached: false,
					},
				}),
			).ansi,
		),
		"feat…:orig…/remo…|0123456789",
	);

	config.format = "$git_branch";
	config.formatAst = parseFormat(config.format);
	config.modules.git_branch.format = "$branch";
	config.modules.git_branch.formatAst = parseFormat(config.modules.git_branch.format);
	config.modules.git_branch.options.truncation_length = 2;
	assert.equal(
		stripAnsi(
			renderStatusline(
				config,
				fixture({
					gitBranchDetails: { name: "A👨‍👩‍👧‍👦BC", detached: false },
				}),
			).ansi,
		),
		"A👨‍👩‍👧‍👦…",
	);
});

test("model exact aliases bypass Pi-specific shortening and then truncate", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$model";
	config.formatAst = parseFormat(config.format);
	config.modules.model.format = "$model";
	config.modules.model.formatAst = parseFormat(config.modules.model.format);
	config.modules.model.options.model_aliases = {
		"claude-sonnet-4-20250514": "claude-team-latest",
	};
	config.modules.model.options.truncation_length = 0;
	config.modules.model.options.truncation_direction = "end";

	assert.equal(stripAnsi(renderStatusline(config, fixture()).ansi), "claude-team-latest");
	config.modules.model.options.truncation_length = 9;
	assert.equal(stripAnsi(renderStatusline(config, fixture()).ansi), "claude-te…");
	assert.equal(
		stripAnsi(
			renderStatusline(config, fixture({ model: { provider: "custom", id: "constructor" } })).ansi,
		),
		"construct…",
	);
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

test("Conda applies Starship path-component truncation in its owning module", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$conda";
	config.formatAst = parseFormat(config.format);
	config.modules.conda.format = "$environment";
	config.modules.conda.formatAst = parseFormat(config.modules.conda.format);
	const runtime = fixture({
		workspace: { modules: { conda: { environment: "/envs/team/work" } } },
	});

	assert.equal(stripAnsi(renderStatusline(config, runtime).ansi), "work");
	config.modules.conda.options.truncation_length = 2;
	assert.equal(stripAnsi(renderStatusline(config, runtime).ansi), "team/work");
	config.modules.conda.options.truncation_length = 0;
	assert.equal(stripAnsi(renderStatusline(config, runtime).ansi), "/envs/team/work");

	if (sep === "/") {
		config.modules.conda.options.truncation_length = 1;
		assert.equal(
			stripAnsi(
				renderStatusline(
					config,
					fixture({ workspace: { modules: { conda: { environment: "/envs/team\\work" } } } }),
				).ansi,
			),
			"team\\work",
		);
	}
});

test("first-wave workspace modules render documented snapshot variables", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	const names = [
		"package",
		"nodejs",
		"python",
		"rust",
		"golang",
		"bun",
		"deno",
		"mise",
		"direnv",
		"conda",
		"pixi",
		"nix_shell",
		"guix_shell",
		"docker_context",
		"kubernetes",
		"terraform",
		"aws",
		"gcloud",
		"azure",
		"openstack",
		"os",
		"container",
		"hostname",
		"username",
	] as const;
	config.format = names.map((name) => `$${name}`).join("|");
	config.formatAst = parseFormat(config.format);
	config.modules.os.disabled = false;
	for (const name of names) {
		config.modules[name].format = name === "package" || name === "nodejs" ? "$version" : "$symbol";
		config.modules[name].formatAst = parseFormat(config.modules[name].format);
	}
	const workspace: Record<string, Record<string, string>> = {};
	for (const [index, name] of names.entries()) {
		workspace[name] =
			name === "package" || name === "nodejs" ? { version: `v${index + 1}.0.0` } : {};
	}
	const rendered = stripAnsi(
		renderStatusline(config, fixture({ workspace: { modules: workspace } }), 400).ansi,
	);
	assert.match(rendered, /v1\.0\.0/);
	assert.match(rendered, /v2\.0\.0/);
	assert.match(rendered, /📦|||||🍞|🦕|mise|direnv|🅒|🧚||🐃||☸|💠|☁|󰠅|⬢|🌐/u);
	assert.equal(rendered.split("|").length, names.length);
});

test("activity handles UI prompts, tools, thinking, completed, and idle", () => {
	const text = (runtime: Partial<StarshipRuntimeSnapshot>, format = "$text") => {
		const config = structuredClone(BUILT_IN_CONFIG);
		config.format = "$activity";
		config.formatAst = [{ type: "variable", name: "activity" }];
		config.modules.activity.format = format;
		config.modules.activity.formatAst = parseFormat(format);
		return stripAnsi(renderStatusline(config, fixture(runtime)).ansi);
	};
	const activeTools = new Map([
		["read", 2],
		["bash", 1],
	]);
	assert.match(text({ activeTools }), /⚙️ read×2\+1/);
	assert.match(text({ isStreaming: true, lastCompletedTool: undefined }), /thinking/);
	assert.match(text({ lastCompletedTool: "bash" }), /completed bash/);
	assert.match(text({ lastCompletedTool: undefined }), /idle/);

	const kinds = ["select", "confirm", "input", "editor", "custom"] as const;
	for (const kind of kinds) {
		assert.match(
			text({ uiPrompt: { kind }, activeTools, isStreaming: true }),
			new RegExp(`waiting for ${kind}`, "u"),
		);
	}
	assert.equal(
		text({ uiPrompt: { kind: "confirm", title: "Deploy production?" } }, "$state|$kind|$title"),
		"waiting|confirm|Deploy production?",
	);
	const unsafeTitle = `Deploy\n\x1b[31mproduction\x1b[0m\u202e ${"界".repeat(30)}`;
	const safeTitle = text({ uiPrompt: { kind: "confirm", title: unsafeTitle } }, "$title");
	assert.equal(safeTitle.includes("\n"), false);
	assert.equal(safeTitle.includes(ESC), false);
	assert.equal(safeTitle.includes("\u202e"), false);
	assert.match(safeTitle, /^Deploy production/u);
	assert.ok(visibleWidth(safeTitle) <= 40);
	assert.match(safeTitle, /…$/u);
	assert.match(
		text({ uiPrompt: { kind: "custom", title: "\x1b[31m\u202e" } }),
		/waiting for custom$/u,
	);
	const zeroWidthTitle = text(
		{ uiPrompt: { kind: "input", title: `a${"\u0301".repeat(1_000)}` } },
		"$title",
	);
	assert.equal([...zeroWidthTitle].length, 256);
	assert.match(zeroWidthTitle, /…$/u);
	assert.ok(visibleWidth(zeroWidthTitle) <= 40);
});

test("extension status icons match arbitrary exact keys and explicit namespace wildcards", () => {
	assert.equal(
		formatExtensionStatus("third_party/key", "running", { "third_party/key": "🧩" }),
		"🧩 running",
	);
	assert.equal(
		formatExtensionStatus("foo:server", "running", {
			"foo:*": "🧪",
			"foo:server": "🖥️",
		}),
		"🖥️ running",
	);
	assert.equal(
		formatExtensionStatus("foo:server:worker", "running", {
			"foo:*": "🧪",
			"foo:server:*": "⚙️",
		}),
		"⚙️ running",
	);
	assert.equal(formatExtensionStatus("foo:worker", "running", { "foo:*": "" }), "running");
	assert.equal(
		formatExtensionStatus("foo:worker", "running", { "@vendor/pi-foo": "PACKAGE" }),
		"🔌 running",
	);
	for (const key of ["foo", "foobar", "foo/server"]) {
		assert.equal(formatExtensionStatus(key, "running", { "foo:*": "🧪" }), "🔌 running");
	}
});

test("extension status icons do not infer known or compatibility keys", () => {
	for (const [key, value] of [
		["sync", "pushing"],
		["retry", "retrying"],
		["pisync", "pushing"],
		["unknown-error-retry", "retrying"],
	] as const) {
		assert.equal(formatExtensionStatus(key, value, {}), `🔌 ${value}`);
	}
	assert.equal(formatExtensionStatus("sync", "pushing", { pisync: "OTHER-KEY" }), "🔌 pushing");
	assert.equal(formatExtensionStatus("retry", "retrying", { retry: "EXACT" }), "EXACT retrying");
});

test("extension status icons honor only explicit keys, suppression, leading icons, and fallback", () => {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = "$extension_status";
	config.formatAst = [{ type: "variable", name: "extension_status" }];
	config.extensionStatus.icons = {
		goal: "",
		"@vendor/pi-foo": "🧪",
		fallback: "•",
	};
	const rendered = renderStatusline(
		config,
		fixture({
			extensionStatuses: new Map([
				["goal", "active"],
				["foo:server", "running"],
				["accounts", "active"],
				["unknown", "⚡ waiting"],
				["toString", "prototype safe"],
			]),
		}),
	).ansi;
	assert.match(rendered, /active/);
	assert.doesNotMatch(rendered, /🎯/);
	assert.match(rendered, /• running/);
	assert.match(rendered, /• active/);
	assert.match(rendered, /⚡ waiting/);
	assert.match(rendered, /• prototype safe/);
	assert.doesNotMatch(rendered, /🧪|👤/u);
});

test("format helpers stay compact and OSC links retain visible width", () => {
	assert.equal(formatCount(1530), "1.5k");
	assert.equal(shortenModel("claude-sonnet-4-20250514"), "sonnet-4");
	assert.equal(visibleWidth(LINK), 4);
});
