import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { expect, test, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { parseStyle } from "../src/format/style.js";
import { inspectStatuslineModules } from "../src/modules/inspection.js";
import { jujutsuModules } from "../src/modules/jujutsu.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot, WorkspaceSnapshot } from "../src/modules/types.js";
import { MAX_COMMAND_OUTPUT_BYTES } from "../src/runtime/helpers.js";
import { parseJujutsuOutput } from "../src/runtime/jujutsu.js";
import { AsyncRefreshController } from "../src/runtime/refresh-controller.js";
import type { WorkspaceExec, WorkspaceRefreshInput } from "../src/runtime/types.js";
import { collectWorkspaceSnapshot, workspaceSnapshotEqual } from "../src/runtime/workspace.js";

const names = ["jj_bookmark", "jj_change", "jj_metrics", "jj_status"] as const;
const changeId = "pvtxwmvtttmrkkoqkutlystlnozssmnk";
const commitId = "30363e463b3a5c87ad352b2d342f7408e3c2dda8";

// Branches derive from Starship ae8fecf3: context/jj_repo.rs and the four
// modules/configs. CLI output is deterministic; a local jj install is not needed.
// Older test labels are shorthand for raw fields, never the production wire format.
function bookmarkFields(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const diverged = value.endsWith("*");
  const label = diverged ? value.slice(0, -1) : value;
  const separator = label.indexOf("@");
  return {
    name: separator < 0 ? label : label.slice(0, separator),
    remote: separator < 0 ? "" : label.slice(separator + 1),
    diverged,
  };
}

function bookmarkRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, key === "bookmarks" && Array.isArray(value) ? value.map(bookmarkFields) : value]),
  );
}

function output(current: Record<string, unknown> = {}, parents: Record<string, unknown> = {}) {
  const ancestorRecords =
    Object.hasOwn(parents, "bookmarks") || Object.hasOwn(parents, "conflicted")
      ? { aaaa: { ...parents, bookmark_source: Array.isArray(parents.bookmarks) && parents.bookmarks.length > 0 } }
      : parents;
  return stringify({
    current: bookmarkRecord({
      has_description: false,
      hidden: false,
      immutable: false,
      divergent: false,
      change_offset: 0,
      change_id: changeId,
      change_id_prefix_len: 3,
      commit_id: commitId,
      commit_id_prefix_len: 4,
      lines_added: 100,
      lines_removed: 90,
      statuses: "ACDMR",
      conflicted: false,
      bookmarks: ["cur_local", "cur_tracked*", "cur_modified@upstream*", "cur_untracked@origin"],
      ...current,
    }),
    parents: Object.fromEntries(
      Object.entries(ancestorRecords).map(([key, value]) => [
        key,
        value && typeof value === "object" && !Array.isArray(value)
          ? bookmarkRecord(value as Record<string, unknown>)
          : value,
      ]),
    ),
  } as Parameters<typeof stringify>[0]);
}

function config(format = names.map((name) => `$${name}`).join(""), options: Record<string, unknown> = {}) {
  return normalizeConfig({
    format,
    ...Object.fromEntries(names.map((name) => [name, { disabled: false }])),
    ...options,
  }).config;
}

function input(overrides: Partial<WorkspaceRefreshInput> = {}): WorkspaceRefreshInput {
  return {
    cwd: "/repo/child",
    config: config(),
    environment: { PATH: "/bin" },
    homeDir: "/home/test",
    platform: "linux",
    hostname: "host",
    username: "user",
    exec: async () => ({ stdout: output(), stderr: "", code: 0, killed: false }),
    fileSystem: {
      readDirectory: async (path) =>
        path === "/repo"
          ? [
              { name: ".git", isDirectory: true, isFile: false },
              { name: ".jj", isDirectory: true, isFile: false },
            ]
          : [],
      readFile: async () => {
        throw new Error("no metadata reads");
      },
      fileExists: async () => false,
    },
    ...overrides,
  };
}

function runtime(workspace: WorkspaceSnapshot): StarshipRuntimeSnapshot {
  return {
    cwd: "/repo",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(0),
    workspace,
  };
}

async function render(
  name: (typeof names)[number],
  current: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
  parents: Record<string, unknown> = {},
) {
  const settings = config(`$${name}`, { [name]: { disabled: false, ...options } });
  const snapshot = await collectWorkspaceSnapshot(
    input({
      config: settings,
      exec: async () => ({ stdout: output(current, parents), stderr: "", code: 0, killed: false }),
    }),
  );
  const rendered = renderStatusline(settings, runtime(snapshot));
  return { text: rendered.chunks.map((chunk) => chunk.text).join(""), rendered, snapshot };
}

test("Jujutsu definitions are opt-in, catalog registered, and excluded from default $all collection", async () => {
  for (const definition of jujutsuModules) assert.equal(definition.defaults.disabled, true);
  const exec = vi.fn<WorkspaceExec>();
  const readDirectory = vi.fn(async () => []);
  const snapshot = await collectWorkspaceSnapshot(
    input({
      config: normalizeConfig({ format: "$jj_bookmark$jj_change$jj_metrics$jj_status" }).config,
      exec,
      fileSystem: { readDirectory },
    }),
  );
  assert.deepEqual(snapshot.modules, {});
  const all = normalizeConfig({ format: "$all" }).config;
  for (const name of names) assert.equal(all.modules[name].disabled, true);
  const hidden = await collectWorkspaceSnapshot(
    input({ config: config("static"), exec, fileSystem: { readDirectory } }),
  );
  assert.deepEqual(hidden.modules, {});
  expect(exec).not.toHaveBeenCalled();
  expect(readDirectory).not.toHaveBeenCalled();
});

test.each(['a"b', "back\\slash", "line\nfeed", "emoji-🪟"])(
  "Jujutsu serializes untrusted bookmark text safely: %s",
  async (bookmark) => {
    const exec = vi.fn<WorkspaceExec>(async () => ({
      stdout: output(
        { bookmarks: [{ name: bookmark, remote: "", diverged: false }] },
        {
          aaaa: {
            bookmarks: [{ name: bookmark, remote: "", diverged: false }],
            conflicted: true,
            bookmark_source: true,
          },
          bbbb: { bookmarks: ["second"], conflicted: true, bookmark_source: false },
        },
      ),
      stderr: "",
      code: 0,
      killed: false,
    }));
    const snapshot = await collectWorkspaceSnapshot(input({ exec }));
    assert.ok(snapshot.modules.jj_change);
    assert.equal(snapshot.modules.jj_status?.conflicted, "true");
    assert.deepEqual(JSON.parse(snapshot.modules.jj_bookmark?.bookmarks ?? "null"), [
      { name: bookmark, remote: "", diverged: false },
      { name: bookmark, remote: "", diverged: false },
    ]);
    const template = exec.mock.calls[0]?.[1].at(-1) ?? "";
    assert.equal((template.match(/bm\.name\(\)\.escape_json\(\)/gu) ?? []).length, 2);
    assert.equal((template.match(/bm\.remote\(\)\.escape_json\(\)/gu) ?? []).length, 2);
    assert.match(template, /"parents\.", commit_id/u);
  },
);

test.each([false, true])(
  "only the latest bookmarked ancestor supplies names, regardless of conflict ancestor order (%s)",
  async (reverse) => {
    const pairs = [
      ["bbbb", { bookmarks: ["nearest"], conflicted: false, bookmark_source: true }],
      ["aaaa", { bookmarks: ["older-conflicted"], conflicted: true, bookmark_source: false }],
    ] as const;
    const parents = Object.fromEntries(reverse ? [...pairs].reverse() : pairs);
    const result = await render("jj_bookmark", { bookmarks: [] }, {}, parents);
    assert.equal(result.text, "on  nearest ");
    assert.equal(parseJujutsuOutput(output({ bookmarks: [] }, parents))?.conflicted, true);
  },
);

test.each([
  { name: 'a"b', remote: "", diverged: false },
  { name: "foo@bar*", remote: "", diverged: false },
  { name: "back\\slash", remote: 'remote@with"quote', diverged: true },
])("raw bookmark fields are not JJ quoted display labels: %j", async (bookmark) => {
  const options = { format: "$bookmark|$remote|$diverged" };
  const result = await render("jj_bookmark", { bookmarks: [bookmark] }, options);
  assert.equal(result.text, `${bookmark.name}|${bookmark.remote}|${bookmark.diverged ? "*" : ""}`);
  assert.equal(
    (await render("jj_bookmark", { bookmarks: [bookmark] }, { ...options, ignore_names: [bookmark.name] })).text,
    "",
  );
  assert.equal(
    (await render("jj_bookmark", { bookmarks: [bookmark] }, { format: "$bookmark", truncation_length: 1 })).text,
    `${[...bookmark.name][0]}…`,
  );
});

test("Jujutsu rejects malformed ancestor tables without accepting a partial snapshot", () => {
  assert.equal(parseJujutsuOutput(output({}, { aaaa: { bookmarks: [42] } })), undefined);
  assert.equal(parseJujutsuOutput(output({}, { aaaa: { conflicted: "true" } })), undefined);
  assert.equal(parseJujutsuOutput(output({}, { aaaa: {}, bbbb: {}, cccc: {} })), undefined);
  assert.equal(parseJujutsuOutput(output({}, { aaaa: { bookmark_source: "true" } })), undefined);
  assert.equal(
    parseJujutsuOutput(output({}, { aaaa: { bookmark_source: true }, bbbb: { bookmark_source: true } })),
    undefined,
  );
});

test("mixed Git/Jujutsu repos use one fixed bounded read-only argv and nearest-bookmark revset", async () => {
  const exec = vi.fn<WorkspaceExec>(async () => ({
    stdout: output({}, { conflicted: true }),
    stderr: "",
    code: 0,
    killed: false,
  }));
  const snapshot = await collectWorkspaceSnapshot(input({ exec }));
  assert.equal(exec.mock.calls.length, 1);
  const [command, args, options] = exec.mock.calls[0] as Parameters<WorkspaceExec>;
  assert.equal(command, "jj");
  assert.deepEqual(args.slice(0, 11), [
    "--color",
    "never",
    "--ignore-working-copy",
    "--no-integrate-operation",
    "--no-pager",
    "--quiet",
    "--repository",
    "/repo",
    "show",
    "@ | latest(heads(mutable() & ::@ & conflicts()), 1) | latest(bookmarks() & ::@, 1)",
    "--no-patch",
  ]);
  assert.equal(args[11], "--template");
  assert.match(args[12] ?? "", /bookmarks\.map/u);
  assert.equal(options.timeout, 2_000);
  assert.equal(options.maxOutputBytes, MAX_COMMAND_OUTPUT_BYTES);
  assert.deepEqual(options.environment, { PATH: "/bin" });
  assert.deepEqual(snapshot.modules.jj_metrics, { added: "100", deleted: "90" });
  assert.deepEqual(snapshot.modules.jj_change, {
    change_id: changeId,
    change_prefix_len: "3",
    commit_id: commitId,
    commit_prefix_len: "4",
  });
  assert.deepEqual(snapshot.modules.jj_status, {
    conflicted: "true",
    has_description: "false",
    hidden: "false",
    immutable: "false",
    added: "1",
    copied: "1",
    deleted: "1",
    modified: "1",
    renamed: "1",
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.modules.jj_change));
});

test.each([
  ["current", ["local", "other"], [], "on  local (+1 others) "],
  ["nearest ancestor", [], ["parent", "parent_remote@origin*"], "on  parent (+1 others) "],
  ["same selected change", ["local"], [], "on  local "],
  ["current plus selected ancestor", ["local"], ["parent"], "on  local (+1 others) "],
  ["none", [], [], ""],
])("bookmark selection: %s", async (_label, bookmarks, parentBookmarks, expected) => {
  assert.equal((await render("jj_bookmark", { bookmarks }, {}, { bookmarks: parentBookmarks })).text, expected);
});

test.each([
  [{ ignore_names: ["cur_local", "cur_tracked"] }, "cur_modified@upstream* (+1)"],
  [{ ignore_names: ["cur_local", "cur_tracked"], ignore_remotes: ["upstream"] }, "cur_untracked@origin"],
  [{ ignore_names: ["cur_local", "cur_tracked"], ignore_remotes: ["origin"] }, "cur_modified@upstream*"],
  [{ ignore_names: ["cur_local", "cur_tracked"], ignore_remotes: ["origin", "upstream"] }, ""],
  [
    { ignore_names: ["cur_local", "cur_tracked"], diverged_symbol: "#", truncation_length: 3, truncation_symbol: "xy" },
    "curx@upsx# (+1)",
  ],
  [{ truncation_length: 0 }, "cur_local (+3)"],
  [{ ignore_names: ["cur_local"] }, "cur_tracked* (+2)"],
])("bookmark exact filters, divergence and truncation: %j", async (options, expected) => {
  assert.equal(
    (await render("jj_bookmark", {}, { format: "$bookmark(@$remote)$diverged( \\(+$overflow_count\\))", ...options }))
      .text,
    expected,
  );
});

test("bookmark transforms sanitize before filtering, splitting and grapheme truncation, without changing snapshot", async () => {
  const raw = "\x1b[31máb@rem\x1b[0m*";
  const result = await render(
    "jj_bookmark",
    { bookmarks: [raw] },
    { format: "$bookmark(@$remote)$diverged", truncation_length: 1, truncation_symbol: "🔸extra" },
  );
  assert.equal(result.text, "á🔸@r🔸*");
  assert.equal(result.snapshot.modules.jj_bookmark?.bookmarks, JSON.stringify([bookmarkFields(raw)]));
  assert.equal((await render("jj_bookmark", { bookmarks: [raw] }, { ignore_names: ["áb"] })).text, "");
});

test.each([
  [{}, {}, "pvtxwmv "],
  [{ divergent: true, change_offset: 2 }, {}, "pvtxwmv/2 "],
  [{ divergent: true, change_offset: 0 }, {}, "pvtxwmv/0 "],
  [{}, { format: "$change_prefix $change_suffix \\($commit_prefix $commit_suffix\\)" }, "pvt xwmv (3036 3e4)"],
  [{}, { change_hash_length: 2, commit_hash_length: 2, format: "$change/$commit" }, "pvt/3036"],
  [{}, { change_hash_length: 255, commit_hash_length: 255, format: "$change/$commit" }, `${changeId}/${commitId}`],
  [{ change_id_prefix_len: 255, commit_id_prefix_len: 255 }, { format: "$change/$commit" }, `${changeId}/${commitId}`],
  [
    { change_id_prefix_len: 0, commit_id_prefix_len: 0 },
    { change_hash_length: 0, commit_hash_length: 0, format: "($change)($commit)" },
    "",
  ],
])("change IDs honor unique-prefix floor and divergence: %j %j", async (current, options, expected) => {
  assert.equal((await render("jj_change", current, options)).text, expected);
});

test("composite $change and $commit honor configured prefix/suffix/offset styles", async () => {
  const result = await render(
    "jj_change",
    { divergent: true, change_offset: 2 },
    { format: "$change/$commit", prefix_style: "italic red", suffix_style: "bold blue", change_offset_style: "yellow" },
  );
  assert.equal(result.text, "pvtxwmv/2/30363e4");
  const chunks = result.rendered.chunks.filter((chunk) => chunk.text);
  assert.deepEqual(chunks[0]?.style, parseStyle("italic red"));
  assert.deepEqual(chunks[1]?.style, parseStyle("bold blue"));
  assert.deepEqual(chunks[2]?.style, parseStyle("yellow"));
});

test.each([
  [100, 90, true, "+100 -90 "],
  [100, 0, true, "+100 "],
  [0, 90, true, "-90 "],
  [0, 0, true, ""],
  [0, 0, false, "+0 -0 "],
  [100, 0, false, "+100 -0 "],
  [0, 90, false, "+0 -90 "],
])("metrics zero branches %i/%i onlyNonzero=%s", async (lines_added, lines_removed, only_nonzero_diffs, expected) => {
  assert.equal((await render("jj_metrics", { lines_added, lines_removed }, { only_nonzero_diffs })).text, expected);
});

test.each([
  [false, false, "◌+=✘~»"],
  [true, false, "!◌+=✘~»"],
  [false, true, "!◌+=✘~»"],
  [true, true, "!◌+=✘~»"],
])("conflict comes from current or mutable ancestor: %s/%s", async (conflicted, parentConflict, expected) => {
  assert.equal(
    (await render("jj_status", { conflicted }, { format: "$all" }, { conflicted: parentConflict })).text,
    expected,
  );
});

test("status templates preserve upstream order, flags, count grammar, static styles and empty states", async () => {
  const all = await render(
    "jj_status",
    { has_description: true, hidden: true, immutable: true, statuses: "AACCCDDDDMMMMMRRRRRR?" },
    {
      format: "$all",
      description_present: "d",
      hidden: "h",
      added: `+\${count}`,
      copied: "=$count",
      deleted: "✘$count",
      modified: "~$count",
      renamed: "»$count",
    },
    { conflicted: true },
  );
  assert.equal(all.text, "!dh◆+2=3✘4~5»6");
  assert.equal((await render("jj_status", { has_description: true, statuses: "" }, { format: "$all" })).text, "");
  assert.equal(
    (
      await render(
        "jj_status",
        {},
        {
          added: "broken[",
          copied: "",
          deleted: "\\$count",
          modified: "[M$count](bold blue)",
          renamed: "$unknown",
          format: "$all",
        },
      )
    ).text,
    "◌+$countM1»",
  );
});

test.each([
  [
    "missing executable",
    async () => {
      throw new Error("ENOENT");
    },
  ],
  ["nonzero status", async () => ({ stdout: output(), stderr: "failure", code: 1, killed: false })],
  ["timeout", async () => ({ stdout: output(), stderr: "", code: 0, killed: true })],
  [
    "oversized output",
    async () => ({ stdout: "x".repeat(MAX_COMMAND_OUTPUT_BYTES + 1), stderr: "", code: 0, killed: false }),
  ],
  ["empty output", async () => ({ stdout: "", stderr: "", code: 0, killed: false })],
  ["malformed output", async () => ({ stdout: "current = broken", stderr: "", code: 0, killed: false })],
] as const)("Jujutsu collection omits unavailable data: %s", async (_label, exec) => {
  assert.deepEqual((await collectWorkspaceSnapshot(input({ exec }))).modules, {});
});

test.each([
  { change_id: "é".repeat(32) },
  { change_id: "short" },
  { commit_id: "" },
  { commit_id: "\x1b" },
  { change_id_prefix_len: -1 },
  { change_id_prefix_len: 256 },
  { commit_id_prefix_len: 1.5 },
  { change_offset: 65_536 },
  { lines_added: -1 },
  { lines_removed: 4_294_967_296 },
  { statuses: 1 },
  { bookmarks: [1] },
  { bookmarks: [{ name: "x", remote: "", diverged: "false" }] },
  { bookmarks: [{ name: "x", remote: "", diverged: false, secret: "must-not-retain" }] },
  { has_description: "false" },
  { conflicted: 1 },
])("Jujutsu parser rejects malformed typed field %j", (current) => {
  assert.equal(parseJujutsuOutput(output(current)), undefined);
});

test("optional parent/current fields default safely and malformed parents fail", () => {
  assert.equal(parseJujutsuOutput(output({}, { conflicted: "true" })), undefined);
  assert.equal(parseJujutsuOutput(output({}, { bookmarks: [false] })), undefined);
  const parsed = parseJujutsuOutput(output({ conflicted: undefined, bookmarks: undefined }));
  assert.ok(parsed);
  assert.deepEqual(parsed.bookmarks, []);
  assert.equal(parsed.conflicted, false);
  assert.equal(parseJujutsuOutput("[parents]\nconflicted = true\n"), undefined);
});

test("non-Jujutsu roots, non-directory markers and bounded ancestor scans never execute jj", async () => {
  const exec = vi.fn<WorkspaceExec>();
  const readDirectory = vi.fn(async () => [{ name: ".jj", isFile: true, isDirectory: false }]);
  const snapshot = await collectWorkspaceSnapshot(
    input({ cwd: `/${Array.from({ length: 100 }, () => "deep").join("/")}`, exec, fileSystem: { readDirectory } }),
  );
  assert.deepEqual(snapshot.modules, {});
  assert.equal(readDirectory.mock.calls.length, 64);
  expect(exec).not.toHaveBeenCalled();
});

test("Jujutsu cancellation before discovery, after discovery and after a delayed command prevents publication", async () => {
  for (const phase of ["before", "discovery", "command"] as const) {
    const controller = new AbortController();
    const exec = vi.fn<WorkspaceExec>(async () => {
      if (phase === "command") controller.abort();
      return { stdout: output(), stderr: "", code: 0, killed: false };
    });
    if (phase === "before") controller.abort();
    const readDirectory = vi.fn(async () => {
      if (phase === "discovery") controller.abort();
      return [{ name: ".jj", isDirectory: true, isFile: false }];
    });
    const snapshot = await collectWorkspaceSnapshot(
      input({ signal: controller.signal, exec, fileSystem: { readDirectory } }),
    );
    assert.deepEqual(snapshot.modules, {});
    assert.equal(exec.mock.calls.length, phase === "command" ? 1 : 0);
    if (phase === "command") assert.equal(exec.mock.calls[0]?.[2].signal, controller.signal);
  }
});

test("refresh replacement and shutdown abort delayed Jujutsu work and reject stale results", async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: AbortSignal | undefined;
  const exec: WorkspaceExec = async (_command, _args, options) => {
    signal = options.signal;
    started();
    await pending;
    return { stdout: output(), stderr: "", code: 0, killed: false };
  };
  const publish = vi.fn();
  const controller = new AsyncRefreshController<WorkspaceRefreshInput, WorkspaceSnapshot>({
    read: (value, signal) => collectWorkspaceSnapshot({ ...value, signal }),
    equal: workspaceSnapshotEqual,
    publish,
  });
  controller.start(1);
  controller.request(input({ exec }));
  await ready;
  controller.start(2);
  assert.equal(signal?.aborted, true);
  release();
  controller.request(input());
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  controller.stop();
  assert.deepEqual(publish.mock.calls[0]?.[0].modules.jj_metrics, { added: "100", deleted: "90" });
});

test("rendering and inspection reuse immutable snapshots without I/O at narrow widths", async () => {
  const exec = vi.fn<WorkspaceExec>(async () => ({ stdout: output(), stderr: "", code: 0, killed: false }));
  const settings = config();
  const snapshot = await collectWorkspaceSnapshot(input({ exec, config: settings }));
  exec.mockClear();
  for (const width of [0, 1, 20, 80]) {
    renderStatusline(settings, runtime(snapshot), width);
    const inspection = inspectStatuslineModules(settings, runtime(snapshot), width);
    assert.equal(inspection.modules.find((item) => item.name === "jj_change")?.state, "Showing");
  }
  expect(exec).not.toHaveBeenCalled();
});

test("read-only Jujutsu collection does not change source files or repository metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "starship-jj-read-only-"));
  try {
    mkdirSync(join(root, ".jj"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".jj", "sentinel"), "operation state\n");
    writeFileSync(join(root, "file.txt"), "source\n");
    const before = [
      readdirSync(root),
      readFileSync(join(root, ".jj", "sentinel")),
      readFileSync(join(root, "file.txt")),
    ];
    await collectWorkspaceSnapshot(input({ cwd: root, fileSystem: undefined }));
    assert.deepEqual(
      [readdirSync(root), readFileSync(join(root, ".jj", "sentinel")), readFileSync(join(root, "file.txt"))],
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Jujutsu status schemas reject invalid, unknown, excessive and deeply nested templates with diagnostics", () => {
  for (const added of ["broken[", "$unknown", "$count".repeat(1_000), `${"(".repeat(17)}$count${")".repeat(17)}`]) {
    const loaded = normalizeConfig({ jj_status: { added } });
    assert.equal(loaded.config.modules.jj_status.options.added, "+");
    assert.ok(loaded.diagnostics.some((item) => item.path === "jj_status.added"));
  }
  const flags = normalizeConfig({ jj_status: { conflicted: "$count", description_empty: "$count" } });
  assert.equal(flags.config.modules.jj_status.options.conflicted, "!");
  assert.equal(flags.config.modules.jj_status.options.description_empty, "◌");
});

test("unknown status letters are ignored and zero unique prefixes use only suffixes", async () => {
  assert.equal((await render("jj_status", { statuses: "?XZ", has_description: true })).text, "");
  assert.equal(
    (await render("jj_change", { change_id_prefix_len: 0, commit_id_prefix_len: 0 }, { format: "$change/$commit" }))
      .text,
    "pvtxwmv/30363e4",
  );
  for (const source of ["current = []\n", "parents = false\n", "x".repeat(MAX_COMMAND_OUTPUT_BYTES + 1)])
    assert.equal(parseJujutsuOutput(source), undefined);
  const exec = vi.fn<WorkspaceExec>();
  const readDirectory = async () => {
    throw new Error("unreadable repository");
  };
  assert.deepEqual((await collectWorkspaceSnapshot(input({ exec, fileSystem: { readDirectory } }))).modules, {});
  expect(exec).not.toHaveBeenCalled();
});
