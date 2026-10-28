import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { BUILT_IN_CONFIG, normalizeConfig } from "../src/config.js";
import { parseFormat } from "../src/format/formatter.js";
import {
  parseGitState,
  parseGitStatusPorcelainV2,
  readGitSnapshot,
  readGitStatus,
  readGitWorktree,
} from "../src/modules/git/runtime.js";
import { gitStatusModule } from "../src/modules/git/status.js";
import { renderStatusTemplate } from "../src/modules/git/status-templates.js";
import { renderStatusline } from "../src/modules/index.js";
import type { GitBranchSnapshot, GitStatusSnapshot, StarshipRuntimeSnapshot } from "../src/modules/types.js";
import { execWorkspaceCommand } from "../src/runtime/command.js";
import type { WorkspaceExec } from "../src/runtime/types.js";

function runtime(overrides: Partial<StarshipRuntimeSnapshot> = {}): StarshipRuntimeSnapshot {
  return {
    cwd: "/workspace",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: "main",
    gitBranchDetails: { name: "main", detached: false },
    gitCommit: { hash: "0123456789abcdef", detached: false },
    gitStatus: status(),
    extensionStatuses: new Map(),
    now: new Date("2026-10-23T10:00:00Z"),
    ...overrides,
  };
}

function status(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return { ...parseGitStatusPorcelainV2("").status, ...overrides };
}

function render(
  name: "git_status" | "git_branch" | "git_commit" | "git_state" | "git_metrics",
  fields: Record<string, unknown>,
  value = runtime(),
): string {
  const { config, diagnostics } = normalizeConfig({ format: `$${name}`, [name]: { disabled: false, ...fields } });
  assert.deepEqual(diagnostics, []);
  return stripVTControlCharacters(renderStatusline(config, value).ansi);
}

// The upstream formatter has 18 count templates, one divergence template, and
// one tracking-clean symbol template. Pi retains its compact count convention.
const countTemplates = [
  ["ahead", "ahead"],
  ["behind", "behind"],
  ["stashed", "stashed"],
  ["conflicted", "conflicted"],
  ["deleted", "deleted"],
  ["renamed", "renamed"],
  ["modified", "modified"],
  ["staged", "staged"],
  ["untracked", "untracked"],
  ["typechanged", "typechanged"],
  ["worktree_added", "worktreeAdded"],
  ["worktree_deleted", "worktreeDeleted"],
  ["worktree_modified", "worktreeModified"],
  ["worktree_typechanged", "worktreeTypechanged"],
  ["index_added", "indexAdded"],
  ["index_deleted", "indexDeleted"],
  ["index_modified", "indexModified"],
  ["index_typechanged", "indexTypechanged"],
] as const;

test.each(countTemplates)("Git status %s template resolves counts and suppresses zero", (name, field) => {
  const fields = { format: `$${name}`, [name]: `${name}:\u0024{count}` };
  assert.equal(render("git_status", fields, runtime({ gitStatus: status({ [field]: 1234 }) })), `${name}:1.2k`);
  assert.equal(render("git_status", fields, runtime({ gitStatus: status({ [field]: 0 }) })), "");
  assert.equal(
    render("git_status", { ...fields, [name]: "literal" }, runtime({ gitStatus: status({ [field]: 0 }) })),
    "",
  );
  assert.equal(render("git_status", { ...fields, [name]: "" }, runtime({ gitStatus: status({ [field]: 1 }) })), "");
});

test.each([-1, 1.5, NaN, Infinity, 9007199254740992])("Git status ignores invalid numeric counts (%s)", (count) => {
  assert.equal(
    render(
      "git_status",
      { format: "$modified$ahead_behind" },
      runtime({ gitStatus: status({ modified: count, ahead: count, behind: count }) }),
    ),
    "",
  );
});

test("Git settings retain Pi defaults and reject invalid control values", () => {
  const modules = BUILT_IN_CONFIG.modules;
  assert.equal(modules.git_branch.options.always_show_remote, true);
  assert.equal(modules.git_branch.options.ignore_bare_repo, true);
  assert.equal(modules.git_branch.options.only_attached, false);
  assert.equal(modules.git_commit.options.only_detached, false);
  assert.equal(modules.git_commit.options.tag_disabled, false);
  assert.equal(modules.git_commit.options.tag_max_candidates, 0);
  assert.equal(modules.git_metrics.options.only_nonzero_diffs, true);
  assert.equal(modules.git_metrics.options.ignore_submodules, false);
  assert.equal(modules.git_status.options.ignore_submodules, false);
  const { diagnostics } = normalizeConfig({
    git_branch: { only_attached: "yes", ignore_branches: "main", ignore_remotes: [1], ignore_bare_repo: 0 },
    git_commit: { only_detached: 1, tag_disabled: "no", tag_max_candidates: 101, tag_symbol: false },
    git_metrics: { only_nonzero_diffs: "yes", ignore_submodules: "true" },
    git_status: { ignore_submodules: 1 },
  });
  assert.equal(diagnostics.length, 11);
});

test("Git status exposes all 20 bounded template schemas", () => {
  const templates = Object.entries(gitStatusModule.options ?? {}).filter(([, schema]) => schema.kind === "string");
  assert.equal(templates.length, 20);
  for (const [name, schema] of templates) {
    assert.equal(schema.kind, "string");
    if (schema.kind !== "string") continue;
    assert.deepEqual(
      schema.templateVariables,
      name === "diverged" ? ["ahead_count", "behind_count"] : name === "up_to_date" ? [] : ["count"],
    );
  }
});

test.each([
  [2, 0, false, "A2"],
  [0, 3, false, "B3"],
  [2, 3, false, "D2/3"],
  [0, 0, true, "clean"],
  [0, 0, false, ""],
] as const)("Git ahead/behind selects exactly one template for +%s -%s", (ahead, behind, upToDate, expected) => {
  assert.equal(
    render(
      "git_status",
      {
        format: "$ahead_behind",
        ahead: "A$count",
        behind: "B$count",
        diverged: `D\${ahead_count}/\${behind_count}`,
        up_to_date: "clean",
      },
      runtime({ gitStatus: status({ ahead, behind, upToDate }) }),
    ),
    expected,
  );
});

test("Git divergence does not fall back to ahead when its explicit template is empty", () => {
  assert.equal(
    render(
      "git_status",
      { format: "$ahead_behind", diverged: "" },
      runtime({ gitStatus: status({ ahead: 3, behind: 2 }) }),
    ),
    "",
  );
});

test("Git clean status distinguishes tracking, missing upstream, gone upstream, and invalid counts", () => {
  for (const [header, expected] of [
    ["# branch.upstream origin/main\n# branch.ab +0 -0", "clean"],
    ["", ""],
    ["# branch.upstream origin/main", ""],
    ["# branch.ab +bad -0", ""],
    ["# branch.ab +9007199254740992 -0", ""],
    ["# branch.ab +1 -0", "⇡1"],
  ]) {
    const parsed = parseGitStatusPorcelainV2(`# branch.head main\n${header}\n`);
    const value = runtime({ gitBranchDetails: parsed.branch, gitStatus: parsed.status });
    assert.equal(render("git_status", { format: "$ahead_behind", up_to_date: "clean" }, value), expected, header);
    assert.equal(render("git_status", {}, runtime({ gitStatus: status() })), "");
  }
});

test("Git status keeps default ordering, symbols, compact counts, and detailed variables", () => {
  const value = runtime({
    gitStatus: status({
      conflicted: 1,
      stashed: 2,
      deleted: 3,
      renamed: 4,
      modified: 5,
      typechanged: 6,
      staged: 7,
      untracked: 8,
      ahead: 1234,
      behind: 2,
      worktreeAdded: 9,
      worktreeDeleted: 10,
      worktreeModified: 11,
      worktreeTypechanged: 12,
      indexAdded: 13,
      indexDeleted: 14,
      indexModified: 15,
      indexTypechanged: 16,
    }),
  });
  assert.equal(render("git_status", {}, value), "=1 $2 ✘3 »4 !5 T6 +7 ?8 ⇕⇡1.2k⇣2 ");
  assert.equal(
    render(
      "git_status",
      {
        format:
          "$worktree_added|$worktree_deleted|$worktree_modified|$worktree_typechanged|$index_added|$index_deleted|$index_modified|$index_typechanged",
      },
      value,
    ),
    "A9|D10|M11|T12|A13|D14|M15|T16",
  );
});

test("Git status templates support escaping, braced variables, conditionals, styles, and safe text", () => {
  const value = runtime({ gitStatus: status({ stashed: 2, modified: 3 }) });
  assert.equal(
    render(
      "git_status",
      {
        format: "$stashed|$modified",
        stashed: String.raw`\[\$$count\]`,
        modified: String.raw`(\($count\))`,
      },
      value,
    ),
    "[$2]|(3)",
  );
  const { config } = normalizeConfig({
    format: "$git_status",
    git_status: { format: "$modified", modified: "[M$count](blue bold)" },
  });
  const chunks = renderStatusline(config, value).modules.git_status;
  assert.deepEqual(chunks[0]?.style?.foreground, { kind: "named", name: "blue" });
  assert.equal(chunks[0]?.style?.bold, true);
  assert.equal(
    renderStatusTemplate("\u001b[31mM$count\u001b[0m\u001b]52;c;bad\u0007", { count: "3" }, {})
      .map((chunk) => chunk.text)
      .join(""),
    "M3",
  );
});

const invalidTemplates = [
  "$hash",
  "$ahead_count",
  `\${unknown}`,
  "$countx",
  "$",
  `\${}`,
  `\${count`,
  "\\q",
  "[x]",
  "(x",
  ")",
  "[$count]($style)",
  "[$count]($count)",
  `${"(".repeat(17)}$count${")".repeat(17)}`,
  "x".repeat(4097),
];

test.each(invalidTemplates)("Git status rejects invalid or out-of-contract template %#", (template) => {
  const { config, diagnostics } = normalizeConfig({
    format: "$git_status",
    git_status: { format: "$modified", modified: template },
  });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.path === "git_status.modified"));
  assert.equal(config.modules.git_status.options.modified, BUILT_IN_CONFIG.modules.git_status.options.modified);
  assert.equal(
    stripVTControlCharacters(renderStatusline(config, runtime({ gitStatus: status({ modified: 2 }) })).ansi),
    "!2",
  );
  assert.deepEqual(renderStatusTemplate(template, { count: "2" }, {}), []);
});

test("Git symbol and divergence templates reject count variables from other template classes", () => {
  for (const [name, template] of [
    ["up_to_date", "$count"],
    ["diverged", "$count"],
    ["diverged", "$ahead_count/$behind_count/$hash"],
  ]) {
    const normalized = normalizeConfig({ git_status: { [name as string]: template } });
    assert.ok(normalized.diagnostics.some((diagnostic) => diagnostic.path === `git_status.${name}`));
  }
});

test("Git status template bounds accept the exact supported length and nesting", () => {
  assert.equal(
    renderStatusTemplate("x".repeat(4096), {}, {})
      .map((chunk) => chunk.text)
      .join("").length,
    4096,
  );
  assert.equal(
    renderStatusTemplate(`${"(".repeat(16)}$count${")".repeat(16)}`, { count: "1" }, {})
      .map((chunk) => chunk.text)
      .join(""),
    "1",
  );
});

test.each([
  [{ name: "main", detached: false }, {}, "main||"],
  [{ name: "HEAD", detached: true }, {}, "HEAD||"],
  [{ name: "HEAD", detached: true }, { only_attached: true }, ""],
  [{ name: "main", detached: false }, { only_attached: true }, "main||"],
  [{ name: "main", detached: false }, { ignore_branches: ["main"] }, ""],
  [{ name: "main", detached: false }, { ignore_branches: ["mai", "MAIN", "m*"] }, "main||"],
  [{ name: "main", detached: false, bare: true }, {}, ""],
  [{ name: "main", detached: false, bare: true }, { ignore_bare_repo: false }, "main||"],
  [{ name: "main", detached: false, bare: true }, { ignore_bare_repo: true }, ""],
  [{ name: "main", remoteName: "origin", remoteBranch: "main", detached: false }, {}, "main|origin|main"],
  [
    { name: "main", remoteName: "origin", remoteBranch: "main", detached: false },
    { always_show_remote: false },
    "main||",
  ],
  [
    { name: "main", remoteName: "origin", remoteBranch: "other", detached: false },
    { always_show_remote: false },
    "main|origin|other",
  ],
  [
    { name: "main", remoteName: "origin", remoteBranch: "other", detached: false },
    { ignore_remotes: ["origin"] },
    "main||other",
  ],
  [
    { name: "main", remoteName: "origin", remoteBranch: "other", detached: false },
    { ignore_remotes: ["orig", "ORIGIN"] },
    "main|origin|other",
  ],
  [{ name: "main", remoteName: "origin", detached: false }, { always_show_remote: false }, "main||"],
  [
    { name: "prefix-local", remoteName: "origin", remoteBranch: "prefix-remote", detached: false },
    { always_show_remote: false, truncation_length: 6 },
    "prefix…||",
  ],
  [{ name: "prefix-local", detached: false }, { ignore_branches: ["prefix…"], truncation_length: 6 }, "prefix…||"],
] as const)("Git branch controls cover source decision class %#", (branch, options, expected) => {
  assert.equal(
    render(
      "git_branch",
      { format: "$branch|$remote_name|$remote_branch", ...options },
      runtime({ gitBranchDetails: branch }),
    ),
    expected,
  );
});

test("Git branch filters and truncation use sanitized display inputs without mutating raw payloads", () => {
  const branch: GitBranchSnapshot = {
    name: "ma\u001b[31min",
    remoteName: "ori\u001b[0mgin",
    remoteBranch: "other",
    detached: false,
  };
  const value = runtime({ gitBranch: branch.name, gitBranchDetails: branch });
  assert.equal(render("git_branch", { format: "$branch", ignore_branches: ["main"] }, value), "");
  assert.equal(
    render("git_branch", { format: "$branch|$remote_name|$remote_branch", ignore_remotes: ["origin"] }, value),
    "main||other",
  );
  assert.equal(branch.name, "ma\u001b[31min");
});

test.each([
  [false, {}, "0123456 🏷 v1"],
  [true, {}, "0123456 🏷 v1"],
  [false, { only_detached: true }, ""],
  [true, { only_detached: true }, "0123456 🏷 v1"],
  [false, { only_detached: false }, "0123456 🏷 v1"],
  [true, { tag_disabled: true }, "0123456"],
  [true, { tag_symbol: "TAG:" }, "0123456TAG:v1"],
  [true, { tag_symbol: "" }, "0123456v1"],
  [true, { commit_hash_length: 0, tag_disabled: true }, ""],
] as const)("Git commit visibility and tag controls cover source decision class %#", (detached, options, expected) => {
  assert.equal(
    render(
      "git_commit",
      { format: "$hash$tag", ...options },
      runtime({ gitCommit: { hash: "0123456789abcdef", tag: "v1", detached } }),
    ),
    expected,
  );
});

test("Git commit missing tags and terminal controls are safe", () => {
  assert.equal(render("git_commit", { format: "$hash$tag" }, runtime({ gitCommit: undefined })), "");
  assert.equal(render("git_commit", { format: "$hash$tag" }), "0123456");
  assert.equal(
    render(
      "git_commit",
      { format: "$tag", tag_symbol: "\u001b[31mT:" },
      runtime({ gitCommit: { hash: "0", tag: "v1\u001b]52;c;bad\u0007", detached: true } }),
    ),
    "T:v1",
  );
});

test.each([
  [0, 0, undefined, ""],
  [0, 0, false, "+0 -0 "],
  [1, 0, undefined, "+1 "],
  [0, 2, undefined, "-2 "],
  [1, 2, true, "+1 -2 "],
  [0, 2, false, "+0 -2 "],
] as const)("Git metrics zero policy covers +%s -%s (%s)", (added, deleted, onlyNonzero, expected) => {
  assert.equal(
    render(
      "git_metrics",
      onlyNonzero === undefined ? {} : { only_nonzero_diffs: onlyNonzero },
      runtime({ gitMetrics: { added, deleted } }),
    ),
    expected,
  );
});

test("Git metrics and status stay empty without snapshots", () => {
  assert.equal(render("git_metrics", { only_nonzero_diffs: false }, runtime({ gitMetrics: undefined })), "");
  assert.equal(render("git_status", { up_to_date: "clean" }, runtime({ gitStatus: undefined })), "");
  assert.equal(render("git_status", { up_to_date: "clean" }, runtime({ gitBranch: null })), "");
});

const stateCases = [
  ["REBASING", "rebase"],
  ["MERGING", "merge"],
  ["REVERTING", "revert"],
  ["CHERRY-PICKING", "cherry_pick"],
  ["BISECTING", "bisect"],
  ["AM", "am"],
  ["AM/REBASE", "am_or_rebase"],
] as const;

test.each(stateCases)("Git state %s label is configurable without changing progress", (state, field) => {
  const value = runtime({ gitState: { state, progressCurrent: 2, progressTotal: 5 } });
  assert.equal(render("git_state", { format: "$state( $progress_current/$progress_total)" }, value), `${state} 2/5`);
  assert.equal(
    render("git_state", { format: "$state( $progress_current/$progress_total)", [field]: "custom" }, value),
    "custom 2/5",
  );
  assert.equal(render("git_state", { format: "$state", [field]: "" }, value), "");
});

test.each([
  ["rebase-merge", undefined, "REBASING"],
  ["rebase-apply", "applying", "AM"],
  ["rebase-apply", "rebasing", "REBASING"],
  ["rebase-apply", undefined, "AM/REBASE"],
  [undefined, "MERGE_HEAD", "MERGING"],
  [undefined, "REVERT_HEAD", "REVERTING"],
  [undefined, "CHERRY_PICK_HEAD", "CHERRY-PICKING"],
  [undefined, "BISECT_LOG", "BISECTING"],
] as const)("Git state collector branch %# is read-only", (directory, marker, expected) => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-state-capabilities-"));
  try {
    const path = directory ? join(root, directory) : root;
    mkdirSync(path, { recursive: true });
    if (marker) writeFileSync(join(path, marker), "marker");
    if (directory) {
      writeFileSync(join(path, directory === "rebase-merge" ? "msgnum" : "next"), "2");
      writeFileSync(join(path, directory === "rebase-merge" ? "end" : "last"), "5");
    }
    const before = inventory(root);
    assert.deepEqual(
      parseGitState(root),
      directory ? { state: expected, progressCurrent: 2, progressTotal: 5 } : { state: expected },
    );
    assert.deepEqual(inventory(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git state preserves detection precedence and rejects incomplete or invalid progress", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-state-order-"));
  try {
    assert.equal(parseGitState(root), undefined);
    mkdirSync(join(root, "rebase-apply"));
    writeFileSync(join(root, "rebase-apply", "applying"), "");
    writeFileSync(join(root, "rebase-apply", "rebasing"), "");
    writeFileSync(join(root, "MERGE_HEAD"), "");
    assert.deepEqual(parseGitState(root), { state: "AM" });
    mkdirSync(join(root, "rebase-merge"));
    for (const current of ["0", "-1", "NaN", "9007199254740992", "1.5", "2"]) {
      writeFileSync(join(root, "rebase-merge", "msgnum"), current);
      assert.deepEqual(parseGitState(root), { state: "REBASING" });
    }
    writeFileSync(join(root, "rebase-merge", "end"), "5");
    assert.deepEqual(parseGitState(root), { state: "REBASING", progressCurrent: 2, progressTotal: 5 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git default collection retains the existing argv and optional command reachability", async () => {
  const commands: string[][] = [];
  const mock = createMockPi();
  Object.assign(mock.rawPi, {
    exec: async (_command: string, args: string[]) => {
      commands.push(args);
      return result(args.includes("status") ? "# branch.head main\n" : "");
    },
  });
  await readGitSnapshot(mock.pi, "/workspace", { includeMetrics: false, includeTag: false });
  assert.deepEqual(commands, [
    ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--show-stash", "--untracked-files=normal"],
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"],
  ]);
  commands.length = 0;
  await readGitSnapshot(mock.pi, "/workspace", { includeMetrics: true, includeTag: true });
  assert.deepEqual(commands.slice(2), [
    ["--no-optional-locks", "diff", "--shortstat", "HEAD", "--"],
    ["describe", "--tags", "--exact-match", "HEAD"],
  ]);
});

test.each([0, 1, 100, -1, 101, 1.5, NaN])("Git tag candidate command is bounded for %s", async (candidates) => {
  const commands: string[][] = [];
  const exec: WorkspaceExec = async (command, args, options) => {
    assert.equal(command, "git");
    assert.equal(options.maxOutputBytes, 64 * 1024);
    assert.equal(options.timeout, 3000);
    commands.push(args);
    return result(args.includes("status") ? "# branch.head main\n" : "");
  };
  await readGitSnapshot(createMockPi().pi, "/workspace", {
    includeMetrics: false,
    includeTag: true,
    tagMaxCandidates: candidates,
    exec,
  });
  assert.deepEqual(
    commands[2],
    Number.isInteger(candidates) && candidates > 0 && candidates <= 100
      ? ["describe", "--tags", "--first-parent", "--abbrev=0", `--candidates=${candidates}`, "HEAD"]
      : ["describe", "--tags", "--exact-match", "HEAD"],
  );
});

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  "Git submodule controls are independent (%s/%s)",
  async (statusIgnoreSubmodules, metricsIgnoreSubmodules) => {
    const commands: string[][] = [];
    const exec: WorkspaceExec = async (_command, args) => {
      commands.push(args);
      return result(args.includes("status") ? "# branch.head main\n" : "");
    };
    await readGitSnapshot(createMockPi().pi, "/workspace", {
      includeMetrics: true,
      includeTag: false,
      statusIgnoreSubmodules,
      metricsIgnoreSubmodules,
      exec,
    });
    assert.equal(commands[0]?.includes("--ignore-submodules=dirty"), statusIgnoreSubmodules);
    assert.equal(commands[2]?.includes("--ignore-submodules=all"), metricsIgnoreSubmodules);
    assert.equal(commands[2]?.includes("--no-ext-diff"), metricsIgnoreSubmodules);
    assert.equal(commands[2]?.includes("--no-textconv"), metricsIgnoreSubmodules);
  },
);

test("Git collection rejects aborted, oversized, killed, and failed optional command results", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let calls = 0;
  const never: WorkspaceExec = async () => {
    calls += 1;
    return result("");
  };
  const pi = createMockPi().pi;
  assert.equal(
    await readGitSnapshot(pi, "/workspace", {
      includeMetrics: true,
      includeTag: true,
      signal: aborted.signal,
      exec: never,
    }),
    undefined,
  );
  assert.equal(calls, 0);
  for (const statusResult of [
    result("x".repeat(64 * 1024 + 1)),
    { ...result("# branch.head main"), killed: true },
    { ...result(""), code: 128 },
  ]) {
    const exec: WorkspaceExec = async (_command, args) => (args.includes("status") ? statusResult : result(""));
    assert.equal(
      await readGitSnapshot(pi, "/workspace", { includeMetrics: false, includeTag: false, exec }),
      undefined,
    );
  }
  const exec: WorkspaceExec = async (_command, args) =>
    args.includes("status")
      ? result("# branch.head main\n# branch.oid 0123456789abcdef\n")
      : { ...result(""), code: 1 };
  const snapshot = await readGitSnapshot(pi, "/workspace", { includeMetrics: true, includeTag: true, exec });
  assert.equal(snapshot?.branch?.name, "main");
  assert.equal(snapshot?.commit?.tag, undefined);
  assert.equal(snapshot?.metrics, undefined);
});

test("Git legacy status and worktree readers reject oversized stdout and stderr consistently", async () => {
  const mock = createMockPi();
  for (const stream of ["stdout", "stderr"]) {
    Object.assign(mock.rawPi, { exec: async () => ({ ...result(""), [stream]: "x".repeat(64 * 1024 + 1) }) });
    assert.equal(await readGitStatus(mock.pi, "/workspace"), undefined);
    assert.equal(await readGitWorktree(mock.pi, "/workspace"), undefined);
  }
});

test("Git refresh revalidates cancellation after await and does not start a stale bare probe", async () => {
  const controller = new AbortController();
  const commands: string[][] = [];
  const exec: WorkspaceExec = async (_command, args) => {
    commands.push(args);
    await Promise.resolve();
    controller.abort();
    return { ...result(""), code: 128 };
  };
  assert.equal(
    await readGitSnapshot(createMockPi().pi, "/workspace", {
      includeMetrics: false,
      includeTag: false,
      inspectBare: true,
      signal: controller.signal,
      exec,
    }),
    undefined,
  );
  assert.equal(commands.length, 2);
});

test.each([
  "not-bare",
  "probe-failed",
  "probe-killed",
  "unborn",
  "invalid-hash",
  "missing-head",
  "prefix-match",
  "upstream-killed",
])("Git bare fallback handles %s without adding unrelated probes", async (scenario) => {
  const commands: string[][] = [];
  const exec: WorkspaceExec = async (_command, args) => {
    commands.push(args);
    if (args.includes("--is-bare-repository")) {
      return scenario === "probe-failed"
        ? { ...result(""), code: 128 }
        : scenario === "probe-killed"
          ? { ...result("true"), killed: true }
          : result(scenario === "not-bare" ? "false" : "true");
    }
    if (args.includes("for-each-ref") && scenario === "prefix-match")
      return result("refs/heads/main/child\0origin/child\n");
    if (args.includes("for-each-ref") && scenario === "upstream-killed") return { ...result(""), killed: true };
    if (args.includes("symbolic-ref")) return scenario === "missing-head" ? { ...result(""), code: 1 } : result("main");
    if (args.includes("--verify"))
      return scenario === "invalid-hash" ? result("not-a-hash") : { ...result(""), code: 128 };
    return { ...result(""), code: 128 };
  };
  const snapshot = await readGitSnapshot(createMockPi().pi, "/workspace", {
    includeMetrics: false,
    includeTag: false,
    inspectBare: true,
    exec,
  });
  if (["unborn", "invalid-hash", "prefix-match", "upstream-killed"].includes(scenario)) {
    assert.equal(snapshot?.branch?.name, "main");
    assert.equal(snapshot?.branch?.bare, true);
    assert.equal(snapshot?.branch?.remoteName, undefined);
    assert.equal(snapshot?.commit, undefined);
  } else assert.equal(snapshot, undefined);
  assert.equal(
    commands.length,
    scenario === "not-bare" || scenario.startsWith("probe-") ? 3 : scenario === "missing-head" ? 5 : 6,
  );
});

test.each(["--is-bare-repository", "symbolic-ref", "for-each-ref"])(
  "Git bare fallback cancels after %s",
  async (abortAt) => {
    const controller = new AbortController();
    const commands: string[][] = [];
    const exec: WorkspaceExec = async (_command, args) => {
      commands.push(args);
      await Promise.resolve();
      if (args.includes(abortAt)) controller.abort();
      return args.includes("--is-bare-repository")
        ? result("true")
        : args.includes("symbolic-ref")
          ? result("main")
          : args.includes("--verify")
            ? result("0123456789abcdef")
            : { ...result(""), code: 128 };
    };
    assert.equal(
      await readGitSnapshot(createMockPi().pi, "/workspace", {
        includeMetrics: false,
        includeTag: false,
        inspectBare: true,
        signal: controller.signal,
        exec,
      }),
      undefined,
    );
    assert.equal(commands.length, abortAt === "--is-bare-repository" ? 3 : abortAt === "symbolic-ref" ? 5 : 6);
  },
);

test.each([false, true])("Git bare fallback handles attached/detached HEAD (%s) without mutation", async (detached) => {
  const root = repository();
  try {
    const bare = join(root, "bare.git");
    git(root, "clone", "--bare", "--local", root, bare);
    if (detached) writeFileSync(join(bare, "HEAD"), `${git(root, "rev-parse", "HEAD")}\n`);
    else {
      git(bare, "config", "branch.main.remote", "origin");
      git(bare, "config", "branch.main.merge", "refs/heads/main");
      git(bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      git(bare, "update-ref", "refs/remotes/origin/main", "HEAD");
    }
    const before = inventory(bare);
    const pi = createMockPi().pi;
    assert.equal(
      await readGitSnapshot(pi, bare, { includeMetrics: false, includeTag: false, exec: execWorkspaceCommand }),
      undefined,
    );
    const snapshot = await readGitSnapshot(pi, bare, {
      includeMetrics: false,
      includeTag: true,
      inspectBare: true,
      exec: execWorkspaceCommand,
    });
    assert.equal(snapshot?.branch?.bare, true);
    assert.equal(snapshot?.branch?.detached, detached);
    assert.equal(snapshot?.branch?.name, detached ? "HEAD" : "main");
    assert.equal(snapshot?.branch?.remoteName, detached ? undefined : "origin");
    assert.equal(snapshot?.branch?.remoteBranch, detached ? undefined : "main");
    assert.equal(snapshot?.commit?.hash, git(root, "rev-parse", "HEAD"));
    assert.deepEqual(inventory(bare), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git tag lookup supports exact/ancestor tags and leaves the user's fixture checkout unchanged", async () => {
  const root = repository();
  try {
    git(root, "tag", "release-base");
    writeFileSync(join(root, "tracked.txt"), "base\nnext\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-qm", "next");
    const pi = createMockPi().pi;
    const before = inventory(root);
    const exact = await readGitSnapshot(pi, root, {
      includeMetrics: true,
      includeTag: true,
      exec: execWorkspaceCommand,
    });
    assert.equal(exact?.commit?.tag, undefined);
    const ancestor = await readGitSnapshot(pi, root, {
      includeMetrics: true,
      includeTag: true,
      tagMaxCandidates: 10,
      exec: execWorkspaceCommand,
    });
    assert.equal(ancestor?.commit?.tag, "release-base");
    assert.deepEqual(inventory(root), before);
    git(root, "tag", "-a", "release-current", "-m", "annotated current");
    git(root, "tag", "light-current");
    const taggedBefore = inventory(root);
    const tagged = await readGitSnapshot(pi, root, {
      includeMetrics: false,
      includeTag: true,
      exec: execWorkspaceCommand,
    });
    assert.equal(tagged?.commit?.tag, "release-current");
    assert.deepEqual(inventory(root), taggedBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git exact lookup selects the first lightweight tag name when no annotated tag exists", async () => {
  const root = repository();
  try {
    git(root, "tag", "light-z");
    git(root, "tag", "light-a");
    const before = inventory(root);
    const snapshot = await readGitSnapshot(createMockPi().pi, root, {
      includeMetrics: false,
      includeTag: true,
      exec: execWorkspaceCommand,
    });
    assert.equal(snapshot?.commit?.tag, "light-a");
    assert.deepEqual(inventory(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git positive candidate lookup follows only the first-parent history", async () => {
  const root = repository();
  try {
    git(root, "tag", "first-parent-tag");
    git(root, "switch", "-qc", "side");
    writeFileSync(join(root, "side.txt"), "side\n");
    git(root, "add", "side.txt");
    git(root, "commit", "-qm", "side");
    git(root, "tag", "side-tag");
    git(root, "switch", "-q", "main");
    writeFileSync(join(root, "main.txt"), "main\n");
    git(root, "add", "main.txt");
    git(root, "commit", "-qm", "main");
    git(root, "merge", "--no-ff", "-qm", "merge side", "side");
    const before = inventory(root);
    const snapshot = await readGitSnapshot(createMockPi().pi, root, {
      includeMetrics: false,
      includeTag: true,
      tagMaxCandidates: 10,
      exec: execWorkspaceCommand,
    });
    assert.equal(snapshot?.commit?.tag, "first-parent-tag");
    assert.deepEqual(inventory(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git submodule status ignores internal dirt but retains changed gitlinks; metrics can ignore gitlinks", async () => {
  const root = repository();
  const source = repository();
  try {
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
    git(root, "commit", "-qam", "submodule");
    const sub = join(root, "sub");
    writeFileSync(join(sub, "tracked.txt"), "base\ninternal dirt\n");
    writeFileSync(join(sub, "untracked.txt"), "internal untracked\n");
    const before = inventory(root);
    const pi = createMockPi().pi;
    const dirty = await readGitSnapshot(pi, root, {
      includeMetrics: true,
      includeTag: false,
      exec: execWorkspaceCommand,
    });
    assert.equal(dirty?.status.modified, 1);
    const ignored = await readGitSnapshot(pi, root, {
      includeMetrics: true,
      includeTag: false,
      statusIgnoreSubmodules: true,
      metricsIgnoreSubmodules: true,
      exec: execWorkspaceCommand,
    });
    assert.equal(ignored?.status.modified, 0);
    assert.deepEqual(ignored?.metrics, { added: 0, deleted: 0 });
    assert.deepEqual(inventory(root), before);
    git(sub, "add", "tracked.txt");
    git(sub, "commit", "-qm", "new submodule commit");
    const gitlinkBefore = inventory(root);
    const changed = await readGitSnapshot(pi, root, {
      includeMetrics: true,
      includeTag: false,
      statusIgnoreSubmodules: true,
      exec: execWorkspaceCommand,
    });
    assert.equal(changed?.status.modified, 1);
    assert.deepEqual(changed?.metrics, { added: 1, deleted: 1 });
    const metricsIgnored = await readGitSnapshot(pi, root, {
      includeMetrics: true,
      includeTag: false,
      metricsIgnoreSubmodules: true,
      exec: execWorkspaceCommand,
    });
    assert.deepEqual(metricsIgnored?.metrics, { added: 0, deleted: 0 });
    assert.deepEqual(inventory(root), gitlinkBefore);
    git(root, "add", "sub");
    const stagedBefore = inventory(root);
    const staged = await readGitSnapshot(pi, root, {
      includeMetrics: true,
      includeTag: false,
      statusIgnoreSubmodules: true,
      metricsIgnoreSubmodules: true,
      exec: execWorkspaceCommand,
    });
    assert.equal(staged?.status.staged, 1);
    assert.equal(staged?.status.indexModified, 1);
    assert.deepEqual(staged?.metrics, { added: 0, deleted: 0 });
    assert.deepEqual(inventory(root), stagedBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("Git rendering reads only snapshots and retains their values across repeated renders", () => {
  const value = runtime({
    gitStatus: status({ modified: 2 }),
    gitMetrics: { added: 3, deleted: 0 },
    gitState: { state: "MERGING" },
  });
  const original = JSON.stringify(value);
  for (const object of [
    value.gitStatus,
    value.gitBranchDetails,
    value.gitCommit,
    value.gitMetrics,
    value.gitState,
    value,
  ])
    Object.freeze(object);
  const config = structuredClone(BUILT_IN_CONFIG);
  config.format = "$git_branch$git_commit$git_status$git_state$git_metrics";
  config.formatAst = parseFormat(config.format);
  config.modules.git_metrics.disabled = false;
  const first = renderStatusline(config, value).ansi;
  assert.equal(renderStatusline(config, value).ansi, first);
  assert.equal(JSON.stringify(value), original);
});

function result(stdout: string) {
  return { stdout, stderr: "", code: 0, killed: false };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-git-capabilities-"));
  try {
    git(root, "init", "-q", "--initial-branch=main");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-qm", "initial");
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function inventory(root: string, path = root): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(result, inventory(root, child));
    else if (entry.isFile())
      result[relative(root, child)] = createHash("sha256").update(readFileSync(child)).digest("hex");
  }
  return result;
}
