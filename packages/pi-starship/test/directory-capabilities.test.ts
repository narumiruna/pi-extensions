import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { DIRECTORY_REPO_ROOT_FORMAT, directoryAlternateFormat } from "../src/modules/directory.js";
import { inspectStatuslineModules } from "../src/modules/inspection.js";
import { reachableModuleRequirements, renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";
import { collectDirectory } from "../src/runtime/directory.js";
import { createFileSystem } from "../src/runtime/helpers.js";
import type { CollectorContext, WorkspaceFileSystem, WorkspaceRefreshInput } from "../src/runtime/types.js";
import { collectWorkspaceSnapshot } from "../src/runtime/workspace.js";

function fixture(overrides: Partial<StarshipRuntimeSnapshot> = {}): StarshipRuntimeSnapshot {
  return {
    cwd: "/home/alice/work/repo/src",
    homeDir: "/home/alice",
    gitRoot: "/home/alice/work/repo",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(2026, 0, 1, 9, 5),
    ...overrides,
  };
}

function settings(options: Record<string, unknown> = {}) {
  const result = normalizeConfig({
    format: "$directory",
    directory: { format: "$path", use_os_path_sep: false, ...options },
  });
  assert.deepEqual(result.diagnostics, []);
  return result.config;
}

function render(options: Record<string, unknown> = {}, runtime: Partial<StarshipRuntimeSnapshot> = {}): string {
  return stripVTControlCharacters(renderStatusline(settings(options), fixture(runtime)).ansi);
}

function context(
  options: Record<string, unknown> = {},
  fileSystem: Partial<WorkspaceFileSystem> = {},
  overrides: Partial<WorkspaceRefreshInput> = {},
): CollectorContext {
  const input: WorkspaceRefreshInput = {
    cwd: "/home/alice/work/repo/src",
    config: settings(options),
    environment: {},
    homeDir: "/home/alice",
    platform: "linux",
    hostname: "host",
    username: "alice",
    exec: async () => {
      throw new Error("unexpected command");
    },
    fileSystem,
    ...overrides,
  };
  const requirements = reachableModuleRequirements(input.config);
  return {
    input,
    requirements,
    fs: createFileSystem(input),
    entries: async () => {
      throw new Error("unexpected listing");
    },
    options: (name) => input.config.modules[name].options,
    needs: (name, variable) => {
      const required = requirements.get(name);
      return Boolean(required && (variable === undefined || required.has(variable)));
    },
  };
}

test("directory no-override output, home/repo contraction, and fallback stay unchanged", () => {
  const { config } = normalizeConfig({ format: "$directory" });
  assert.equal(stripVTControlCharacters(renderStatusline(config, fixture()).ansi), " 📁 repo/src ");
  for (const [runtime, expected] of [
    [{ cwd: "/home/alice", gitRoot: undefined }, "~"],
    [{ cwd: "/home/alice/src", gitRoot: "/home/alice" }, "~/src"],
    [{ cwd: "/home/alice/work/repo" }, "repo"],
    [{ cwd: "/home/alice/work/repo/a/b/c" }, "a/b/c"],
    [{ cwd: "/outside/other", gitRoot: "/home/alice/work/repo" }, "/outside/other"],
    [{ cwd: "/", homeDir: undefined, gitRoot: undefined }, "/"],
  ] as const) {
    assert.equal(render({}, runtime), expected);
  }
});

test("directory physical selection consumes metadata and falls back without changing logical mode", () => {
  const runtime = {
    cwd: "/home/alice/link/src",
    gitRoot: "/real/repo",
    workspace: { modules: { directory: { physical_path: "/real/repo/src" } } },
  };
  assert.equal(render({ format: "$path|$full_path" }, runtime), "~/link/src|/home/alice/link/src");
  assert.equal(render({ format: "$path|$full_path", use_logical_path: false }, runtime), "repo/src|/real/repo/src");
  assert.equal(render({ use_logical_path: false }, { ...runtime, workspace: undefined }), "~/link/src");
});

test("directory selects repo-root formats only when a root exists in the visible path", () => {
  const options = {
    format: "NORMAL:$path",
    repo_root_format: "$before_root_path|$repo_root|$path",
    truncation_length: 0,
  };
  assert.equal(render(options), "|repo|/src");
  assert.equal(render(options, { cwd: "/home/alice/work/repo" }), "|repo|");
  assert.equal(render({ ...options, truncate_to_repo: false }), "~/work/|repo|/src");
  assert.equal(
    render({ ...options, truncate_to_repo: false, truncation_length: 3, truncation_symbol: "…/" }),
    "…/work/|repo|/src",
  );
  assert.equal(render({ ...options, truncation_length: 2 }), "|repo|/src");
  assert.equal(render({ ...options, truncation_length: 1 }), "NORMAL:src");
  assert.equal(render(options, { gitRoot: undefined }), "NORMAL:~/work/repo/src");
  assert.equal(render(options, { cwd: "/home/alice/sideways", gitRoot: "/real/repo" }), "NORMAL:~/sideways");
});

test("directory root styles inherit base style and preserve the Pi symbol/spacing", () => {
  const config = settings({
    truncate_to_repo: false,
    truncation_length: 0,
    repo_root_style: "green",
    before_repo_root_style: "blue",
    read_only_style: "red",
  });
  const rendered = renderStatusline(config, fixture({ workspace: { modules: { directory: { read_only: "true" } } } }));
  assert.equal(stripVTControlCharacters(rendered.ansi), " 📁 ~/work/repo/src 🔒");
  const chunks = rendered.modules.directory;
  assert.deepEqual(chunks.find(({ text }) => text === "~/work/")?.style?.foreground, { kind: "named", name: "blue" });
  assert.deepEqual(chunks.find(({ text }) => text === "repo")?.style?.foreground, { kind: "named", name: "green" });
  assert.deepEqual(chunks.find(({ text }) => text === "/src")?.style?.foreground, { kind: "named", name: "cyan" });
  assert.deepEqual(chunks.find(({ text }) => text === "🔒")?.style?.foreground, { kind: "named", name: "red" });
  assert.equal(render({ repo_root_style: "none" }), " 📁 repo/src ");
  assert.equal(directoryAlternateFormat({}, {}), undefined);
  assert.equal(directoryAlternateFormat({}, { before_repo_root_style: "blue" }), undefined);
  assert.equal(directoryAlternateFormat({}, { repo_root_style: "green" }), DIRECTORY_REPO_ROOT_FORMAT);
  assert.equal(directoryAlternateFormat({ repo_root_format: "$repo_root" }, {}), "$repo_root");
  const inherited = renderStatusline(
    settings({ repo_root_format: "[$repo_root]($repo_root_style)[$path]($before_repo_root_style)", style: "yellow" }),
    fixture(),
  );
  assert.equal(stripVTControlCharacters(inherited.ansi), "repo/src");
  assert.equal(
    inherited.modules.directory.every(
      ({ style }) => style?.foreground?.kind === "named" && style.foreground.name === "yellow",
    ),
    true,
  );
});

test("directory root matching handles repeated root names and does not split an out-of-tree logical symlink", () => {
  assert.equal(
    render(
      { truncate_to_repo: false, truncation_length: 0, repo_root_format: "$before_root_path|$repo_root|$path" },
      {
        cwd: "/home/alice/repo/repo/src",
        gitRoot: "/home/alice/repo/repo",
      },
    ),
    "~/repo/|repo|/src",
  );
  const runtime = {
    cwd: "/home/alice/link",
    gitRoot: "/real/repo",
    workspace: { modules: { directory: { physical_path: "/real/repo/src" } } },
  };
  assert.equal(render({ repo_root_style: "green" }, runtime), "~/link");
  assert.equal(render({ repo_root_style: "green", use_logical_path: false }, runtime), " 📁 repo/src ");
});

test("directory read-only indicator uses only cached known-denied metadata", () => {
  for (const [readOnly, expected] of [
    ["true", "repo/srcLOCK"],
    ["false", "repo/src"],
    ["unknown", "repo/src"],
  ]) {
    assert.equal(
      render(
        { format: "$path($read_only)", read_only: "LOCK" },
        { workspace: { modules: { directory: { read_only: readOnly as string } } } },
      ),
      expected,
    );
  }
  assert.equal(render({ format: "$path($read_only)" }), "repo/src");
  assert.equal(
    render(
      { format: "$path($read_only)", read_only: "" },
      { workspace: { modules: { directory: { read_only: "true" } } } },
    ),
    "repo/src",
  );
});

test("directory substitution maps and literal rows replace all matches with literal replacement text", () => {
  for (const substitutions of [
    { src: "lib" },
    [{ from: "src", to: "lib" }],
    [{ from: "src", to: "lib", regex: false }],
  ]) {
    assert.equal(render({ substitutions }, { cwd: "/home/alice/work/repo/src/src" }), "repo/lib/lib");
  }
  assert.equal(render({ substitutions: { repo: `$&$$\${name}` } }), `$&$$\${name}/src`);
  assert.equal(render({ substitutions: { "": "ignored", repo: "project", project: "work" } }), "work/src");
  assert.equal(render({ substitutions: { repo: "project" }, repo_root_format: "$repo_root|$path" }), "project|/src");
  assert.equal(render({ substitutions: { "repo/src": "merged" }, repo_root_format: "$repo_root|$path" }), "merged");
});

test("directory structured regex uses bounded RE2 first-match and Rust-style captures", () => {
  assert.equal(
    render({ substitutions: [{ from: "src", to: "lib", regex: true }] }, { cwd: "/home/alice/work/repo/src/src" }),
    "repo/lib/src",
  );
  assert.equal(
    render({ substitutions: [{ from: "(?P<name>repo)", to: `\${name}-$1-$$-$missing`, regex: true }] }),
    "repo-repo-$-/src",
  );
  assert.equal(render({ substitutions: [{ from: "^", to: "prefix/", regex: true }] }), "prefix/repo/src");
  assert.equal(render({ substitutions: [{ from: "not-present", to: "changed", regex: true }] }), "repo/src");
  const config = settings();
  config.modules.directory.options.substitutions = [
    { from: "repo", to: "changed" },
    { from: "[", to: "bad", regex: true },
  ];
  assert.equal(stripVTControlCharacters(renderStatusline(config, fixture()).ansi), "repo/src");
});

test("directory substitution safety failures preserve the complete original path", () => {
  const config = settings({ truncation_length: 0 });
  for (const substitutions of [
    Array.from({ length: 65 }, () => ({ from: "repo", to: "changed" })),
    [{ from: "repo", to: "x".repeat(16_385) }],
    [
      { from: "repo", to: "changed" },
      { from: "src", to: "x".repeat(4_097), regex: true },
    ],
  ]) {
    config.modules.directory.options.substitutions = substitutions;
    assert.equal(stripVTControlCharacters(renderStatusline(config, fixture()).ansi), "repo/src");
  }
  const long = "a".repeat(4_097);
  config.modules.directory.options.substitutions = [{ from: "(a+)+$", to: "match", regex: true }];
  assert.equal(
    stripVTControlCharacters(renderStatusline(config, fixture({ cwd: `/repo/${long}`, gitRoot: "/repo" })).ansi),
    `repo/${long}`,
  );
});

test("directory substitutions disable fish prefixes and preserve truncation order", () => {
  const runtime = { cwd: "/home/alice/.config/parent/repo/src", gitRoot: "/home/alice/.config/parent/repo" };
  assert.equal(render({ truncation_length: 2, fish_style_pwd_dir_length: 1 }, runtime), "~/.c/p/repo/src");
  assert.equal(
    render(
      {
        truncation_length: 2,
        fish_style_pwd_dir_length: 1,
        truncation_symbol: "…/",
        substitutions: [{ from: "repo", to: "project" }],
      },
      runtime,
    ),
    "…/project/src",
  );
  assert.equal(render({ truncation_length: 1, substitutions: { "repo/src": "one/two/three" } }), "three");
});

test("directory sanitizes logical/physical paths, root fields, and substitution text before splitting", () => {
  const config = settings({
    use_logical_path: false,
    repo_root_format: "$repo_root|$path|$full_path|$read_only",
    substitutions: [{ from: "src", to: "\x1b[31mlib\x1b[0m" }],
    read_only: "\x1b[31mLOCK\x1b[0m",
  });
  const runtime = fixture({
    gitRoot: "/real/\x1b[31mrepo\x1b[0m",
    workspace: { modules: { directory: { physical_path: "/real/\x1b[31mrepo\x1b[0m/src\nline", read_only: "true" } } },
  });
  const original = structuredClone(config.modules.directory.options);
  const rendered = renderStatusline(config, runtime);
  assert.equal(stripVTControlCharacters(rendered.ansi), "repo|/lib line|/real/repo/src line|LOCK");
  assert.deepEqual(config.modules.directory.options, original);
  assert.equal(runtime.workspace?.modules.directory?.physical_path, "/real/\x1b[31mrepo\x1b[0m/src\nline");
});

test("directory normalizes structured substitution shapes and rejects unsupported regex syntax", () => {
  for (const substitutions of [
    [{ from: "a", to: "b", regex: "yes" }],
    [{ from: "a" }],
    [{ from: "a", to: "b", extra: true }],
    [{ from: "(?=a)", to: "b", regex: true }],
    [{ from: "(a)\\1", to: "b", regex: true }],
  ]) {
    const result = normalizeConfig({ directory: { substitutions } });
    assert.equal(
      result.diagnostics.some(({ path }) => path === "directory.substitutions"),
      true,
    );
    assert.deepEqual(result.config.modules.directory.options.substitutions, {});
  }
});

test("directory metadata probes are reachable, variable-gated, and absent by default", async () => {
  for (const [options, root, physical, permissions] of [
    [{}, "$directory", 0, 0],
    [{ disabled: true, use_logical_path: false }, "$directory", 0, 0],
    [{ use_logical_path: false }, "$time", 0, 0],
    [{ use_logical_path: false, format: "$symbol" }, "$directory", 0, 0],
    [{ use_logical_path: false }, "$directory", 1, 0],
    [{ use_logical_path: false, format: "$full_path" }, "$directory", 1, 0],
    [{ format: "$read_only" }, "$directory", 0, 1],
    [{ format: "$read_only", read_only: "" }, "$directory", 0, 0],
    [{ format: "$read_only", read_only: "\x1b[31m\x1b[0m" }, "$directory", 0, 0],
    [{ format: "$path$read_only", use_logical_path: false }, "$directory", 1, 1],
    [{ format: "$symbol", repo_root_format: "$repo_root$read_only", use_logical_path: false }, "$directory", 1, 1],
    [{ repo_root_style: "green" }, "$directory", 0, 1],
    [{ before_repo_root_style: "blue" }, "$directory", 0, 0],
  ] as const) {
    const realPath = vi.fn(async () => "/real/repo/src");
    const isWritable = vi.fn(async () => false);
    const config = normalizeConfig({ format: root, directory: { format: "$path", ...options } }).config;
    const ctx = context({}, { realPath, isWritable }, { config });
    await collectDirectory(ctx);
    assert.equal(realPath.mock.calls.length, physical, JSON.stringify(options));
    assert.equal(isWritable.mock.calls.length, permissions, JSON.stringify(options));
  }
});

test("directory metadata handles permission allowed, denied, missing, and failed probes", async () => {
  for (const [writable, expected] of [
    [true, "false"],
    [false, "true"],
    [undefined, undefined],
  ] as const) {
    assert.deepEqual(
      await collectDirectory(context({ format: "$read_only" }, { isWritable: async () => writable })),
      expected === undefined ? {} : { directory: { read_only: expected } },
    );
  }
  assert.deepEqual(
    await collectDirectory(
      context(
        { format: "$read_only" },
        {
          isWritable: async () => {
            throw new Error("unavailable");
          },
        },
      ),
    ),
    {},
  );
  assert.deepEqual(
    await collectDirectory(context({ use_logical_path: false }, { realPath: async () => undefined })),
    {},
  );
  assert.deepEqual(
    await collectDirectory(context({ use_logical_path: false }, { realPath: async () => "relative/path" })),
    {},
  );
  assert.deepEqual(
    await collectDirectory(
      context(
        { use_logical_path: false },
        {
          realPath: async () => {
            throw new Error("unavailable");
          },
        },
      ),
    ),
    {},
  );
});

test("directory metadata does not start probes for an already-cancelled refresh", async () => {
  const controller = new AbortController();
  controller.abort();
  const realPath = vi.fn(async () => "/real/repo/src");
  const isWritable = vi.fn(async () => false);
  assert.deepEqual(
    await collectDirectory(
      context(
        { format: "$path$read_only", use_logical_path: false },
        { realPath, isWritable },
        { signal: controller.signal },
      ),
    ),
    {},
  );
  assert.equal(realPath.mock.calls.length, 0);
  assert.equal(isWritable.mock.calls.length, 0);
});

test("directory collector discards delayed path and permission results after cancellation", async () => {
  for (const kind of ["path", "permission"] as const) {
    const controller = new AbortController();
    let announce: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realPath = vi.fn(async () => {
      if (kind === "path") {
        announce();
        await pending;
      }
      return "/real/repo/src";
    });
    const isWritable = vi.fn(async () => {
      if (kind === "permission") {
        announce();
        await pending;
      }
      return false;
    });
    const collecting = collectDirectory(
      context(
        { format: "$path$read_only", use_logical_path: false },
        { realPath, isWritable },
        { signal: controller.signal },
      ),
    );
    await ready;
    controller.abort();
    release();
    assert.deepEqual(await collecting, {});
    assert.equal(isWritable.mock.calls.length, kind === "path" ? 0 : 1);
  }
});

test("workspace integrates frozen directory metadata without a listing or command", async () => {
  const listing = vi.fn(async () => {
    throw new Error("unexpected listing");
  });
  const ctx = context(
    { format: "$path$read_only", use_logical_path: false },
    { realPath: async () => "/real/repo/src", isWritable: async () => false, readDirectory: listing },
  );
  const snapshot = await collectWorkspaceSnapshot(ctx.input);
  assert.deepEqual(snapshot.modules.directory, { physical_path: "/real/repo/src", read_only: "true" });
  assert.equal(Object.isFrozen(snapshot.modules.directory), true);
  assert.equal(listing.mock.calls.length, 0);
  assert.equal(
    render(
      { format: "$path$read_only", use_logical_path: false },
      { cwd: "/logical/path", gitRoot: "/real/repo", workspace: snapshot },
    ),
    "repo/src🔒",
  );
});

test("directory native metadata resolves a symlink only when physical mode is requested", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-directory-"));
  const physical = join(root, "repo", "src");
  const logical = join(root, "link");
  try {
    mkdirSync(physical, { recursive: true });
    symlinkSync(physical, logical);
    const snapshot = await collectWorkspaceSnapshot(
      context({ format: "$full_path($read_only)", use_logical_path: false }, {}, { cwd: logical }).input,
    );
    assert.equal(snapshot.modules.directory?.physical_path, await fsPromises.realpath(physical));
    assert.equal(snapshot.modules.directory?.read_only, "false");
    assert.deepEqual(await collectDirectory(context({ format: "$read_only" }, {}, { cwd: join(root, "missing") })), {});
    assert.equal(
      render({ format: "$full_path", use_logical_path: false }, { cwd: logical, workspace: snapshot }),
      await fsPromises.realpath(physical),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory render and non-interactive preview/inspection output perform no I/O", () => {
  const probes = [
    vi.spyOn(fs, "realpathSync"),
    vi.spyOn(fs, "statSync"),
    vi.spyOn(fs, "readFileSync"),
    vi.spyOn(fsPromises, "realpath"),
    vi.spyOn(fsPromises, "access"),
    vi.spyOn(fsPromises, "stat"),
  ];
  const config = settings({
    format: "$path$read_only",
    use_logical_path: false,
    repo_root_format: "$before_root_path$repo_root$path$read_only",
  });
  const runtime = fixture({
    gitRoot: "/real/repo",
    workspace: { modules: { directory: { physical_path: "/real/repo/src", read_only: "true" } } },
  });
  const first = renderStatusline(config, runtime);
  const preview = renderStatusline(structuredClone(config), runtime, 40);
  const inspection = inspectStatuslineModules(config, runtime).modules.find(({ name }) => name === "directory");
  assert.ok(inspection);
  assert.equal(inspection.state, "Showing");
  assert.equal(inspection.preview, "repo/src🔒");
  assert.equal(inspection.variables.includes("read_only"), true);
  assert.equal(inspection.styleFields.includes("repo_root_style"), true);
  assert.equal(stripVTControlCharacters(first.ansi), "repo/src🔒");
  assert.equal(preview.ansi, first.ansi);
  assert.equal(first.modules.directory.map(({ text }) => text).join(""), "repo/src🔒");
  for (const probe of probes) assert.equal(probe.mock.calls.length, 0);
});
