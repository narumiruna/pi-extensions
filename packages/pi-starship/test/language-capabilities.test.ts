import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { formatVersion } from "../src/format/version.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";
import { parseRuntimeVersion } from "../src/runtime/languages.js";
import type { WorkspaceExec, WorkspaceRefreshInput } from "../src/runtime/types.js";
import { goRequirementSatisfied, nodeRequirementSatisfied } from "../src/runtime/version-requirements.js";
import { collectWorkspaceSnapshot } from "../src/runtime/workspace.js";

const success = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });

type Language = "python" | "nodejs" | "golang" | "rust" | "bun" | "deno";

async function collect(
  name: Language,
  module: Record<string, unknown> = {},
  fixture: {
    files?: Record<string, string>;
    environment?: Record<string, string | undefined>;
    exec?: WorkspaceExec;
    exists?: readonly string[];
    signal?: AbortSignal;
    platform?: NodeJS.Platform;
    noMarker?: boolean;
  } = {},
) {
  const { config, diagnostics } = normalizeConfig({
    format: `$${name}`,
    [name]: { format: "$version", detect_files: ["marker"], ...module },
  });
  assert.deepEqual(diagnostics, []);
  const calls: [string, string[]][] = [];
  const reads: string[] = [];
  const probes: string[] = [];
  const input: WorkspaceRefreshInput = {
    cwd: "/work",
    config,
    environment: fixture.environment ?? {},
    homeDir: "/home/user",
    platform: fixture.platform ?? "linux",
    hostname: "host.example",
    username: "user",
    signal: fixture.signal,
    fileSystem: {
      readDirectory: async () => (fixture.noMarker ? [] : [{ name: "marker", isFile: true, isDirectory: false }]),
      readFile: async (path, maxBytes) => {
        reads.push(path);
        assert.equal(maxBytes, 65_536);
        return fixture.files?.[path];
      },
      fileExists: async (path) => {
        probes.push(path);
        return fixture.exists?.includes(path) ?? false;
      },
    },
    exec: async (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.timeout, 2_000);
      assert.equal(options.maxOutputBytes, 65_536);
      assert.equal(options.signal, fixture.signal);
      if (name === "golang") assert.deepEqual(options.environment, { ...input.environment, GOTOOLCHAIN: "local" });
      else assert.equal(options.environment, input.environment);
      return fixture.exec ? fixture.exec(command, args, options) : success("Python 3.13.2");
    },
  };
  const snapshot = await collectWorkspaceSnapshot(input);
  return { snapshot, calls, reads, probes, config };
}

function runtime(workspace: StarshipRuntimeSnapshot["workspace"]): StarshipRuntimeSnapshot {
  return {
    cwd: "/work",
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

// Starship formatter/version.rs branches: ideal, general/partial, and unparseable.
// Pi keeps its prior leading-v normalization and uses the package's format grammar.
test.each([
  ["v1.2.3", undefined, "v1.2.3"],
  ["1.2.3", `\${major}:\${minor}:\${patch}:\${raw}`, "1:2:3:1.2.3"],
  ["1.2.3-rc.1+build.2", "$major.$minor.$patch|$raw", "1.2.3|1.2.3-rc.1+build.2"],
  ["1.2", `$major.$minor(.$patch)|\${raw}`, "1.2|1.2"],
  ["1", "$major:$minor:$patch", "1::"],
  ["1.2-a.3", "$major:$minor:$patch", "1:2:"],
  ["3.14.0rc2", "$major:$minor:$patch", "3:14:0"],
  ["01.002.0003", "$major:$minor:$patch", "1:2:3"],
  ["1.2.3.4", "$major:$minor:$patch", "1:2:3"],
  ["1..2", "$major:$minor:$patch|$raw", "::|1..2"],
  ["1.2.", "$major:$minor:$patch|$raw", "::|1.2."],
  ["dummy version", "$major:$minor:$patch:$raw", ":::dummy version"],
  ["v1.0.0", `\\$raw:$unknown:\${raw}`, "$raw::1.0.0"],
  ["1.0", "[$major](red)", "1"],
  ["1.0", "", ""],
  ["1.0", "${raw", "v1.0"],
  ["1.0", "$", "v1.0"],
  ["1.0", "($raw", "v1.0"],
  ["1.0", "\\q", "v1.0"],
])("shared version format %s / %s", (raw, template, expected) => {
  assert.equal(formatVersion(raw, template), expected);
});

test("version templates are bounded before parsing", () => {
  assert.equal(formatVersion("1.0", "x".repeat(4_097)), "v1.0");
});

test("language collectors all use the shared version formatter", async () => {
  const cases = [
    ["python", "Python 3.13.2", "3/13/2/3.13.2"],
    ["nodejs", "v22.3.1", "22/3/1/22.3.1"],
    ["golang", "go version go1.24 linux/amd64", "1/24//1.24"],
    ["rust", "rustc 1.85.0 (hash)", "1/85/0/1.85.0"],
    ["bun", "1.2.3", "1/2/3/1.2.3"],
    ["deno", "deno 2.1.4", "2/1/4/2.1.4"],
  ] as const;
  for (const [name, output, expected] of cases) {
    const result = await collect(
      name,
      { version_format: `\${major}/$minor/$patch/\${raw}` },
      {
        environment: { RUSTC: "/compiler/rustc" },
        exists: ["/compiler/rustc"],
        exec: async () => success(output),
      },
    );
    assert.equal(result.snapshot.modules[name]?.version, expected);
    assert.equal(result.calls.length, 1);
  }
});

test("Python preserves the default active-venv and fallback interpreter choices", async () => {
  for (const [platform, candidate] of [
    ["linux", "/env/bin/python"],
    ["win32", "/env/Scripts/python.exe"],
  ] as const) {
    const active = await collect("python", {}, { environment: { VIRTUAL_ENV: "/env" }, exists: [candidate], platform });
    assert.deepEqual(active.calls, [[candidate, ["--version"]]]);
  }
  const missing = await collect("python", {}, { environment: { VIRTUAL_ENV: "/env" } });
  assert.deepEqual(missing.calls, [["python", ["--version"]]]);
  const absent = await collect("python");
  assert.deepEqual(absent.calls, [["python", ["--version"]]]);
  assert.deepEqual(absent.reads, []);
});

test("Python executes explicit alternatives as argv and appends only --version", async () => {
  const result = await collect(
    "python",
    {
      python_binary: [
        ["missing-python", "-I"],
        ["py", "-3", "literal; $(no-shell)"],
      ],
    },
    {
      environment: { VIRTUAL_ENV: "/env" },
      exists: ["/env/bin/python"],
      exec: async (command) =>
        command === "missing-python" ? { ...success(""), code: 127 } : success("Python 3.13.2"),
    },
  );
  assert.deepEqual(result.calls, [
    ["missing-python", ["-I", "--version"]],
    ["py", ["-3", "literal; $(no-shell)", "--version"]],
  ]);
  assert.deepEqual(result.probes, []);
  assert.equal(result.snapshot.modules.python?.version, "v3.13.2");
  const scalar = await collect("python", { python_binary: "python3" });
  assert.deepEqual(scalar.calls, [["python3", ["--version"]]]);
  const strings = await collect(
    "python",
    { python_binary: ["missing", "python3"] },
    {
      exec: async (command) => (command === "missing" ? { ...success(""), killed: true } : success("Python 3.13.2")),
    },
  );
  assert.deepEqual(strings.calls, [
    ["missing", ["--version"]],
    ["python3", ["--version"]],
  ]);
});

test.each(["", "banner", "Python 3.13.2\n[PyPy]", "Python 3.6.10 :: Anaconda, Inc."])(
  "Python preserves strict parsing after a successful command: %j",
  async (output) => {
    const result = await collect(
      "python",
      { python_binary: ["first", "second"] },
      { exec: async () => success(output) },
    );
    assert.equal(result.snapshot.modules.python?.version, undefined);
    assert.deepEqual(result.calls, [["first", ["--version"]]]);
  },
);

test("Python alternatives handle absence, timeout, errors, and cancellation without stale work", async () => {
  for (const exec of [
    async () => ({ ...success(""), killed: true }),
    async () => ({ ...success(""), code: 127 }),
    async () => {
      throw new Error("ENOENT");
    },
  ] satisfies WorkspaceExec[]) {
    const result = await collect("python", { python_binary: ["a", "b"] }, { exec });
    assert.equal(result.snapshot.modules.python?.version, undefined);
    assert.equal(result.calls.length, 2);
  }
  const controller = new AbortController();
  const result = await collect(
    "python",
    { python_binary: ["a", "b"] },
    {
      signal: controller.signal,
      exec: async () => {
        controller.abort();
        return success("Python 3.13.2");
      },
    },
  );
  assert.deepEqual(result.calls, [["a", ["--version"]]]);
  assert.deepEqual(result.snapshot.modules, {});
  const already = await collect("python", {}, { signal: controller.signal });
  assert.deepEqual(already.calls, []);
});

test.each([
  [{ PYENV_VERSION: "3.13/envs/work" }, "3.13/envs/work", []],
  [{ PYENV_VERSION: "" }, undefined, []],
  [{}, "3.13/envs/from-command", [["pyenv", ["version-name"]]]],
] as const)("Python pyenv label branch %j", async (environment, expected, calls) => {
  const result = await collect(
    "python",
    {
      format: "$pyenv_prefix$version",
      pyenv_version_name: true,
      pyenv_prefix: "chosen ",
      version_format: "ignored-$raw",
    },
    { environment, exec: async () => success("3.13/envs/from-command\n") },
  );
  assert.equal(result.snapshot.modules.python?.version, expected);
  assert.equal(result.snapshot.modules.python?.pyenv_prefix, "chosen ");
  assert.deepEqual(result.calls, calls);
});

test("Python retains legacy prefix labels, Conda fallback, and opt-in generic names", async () => {
  const legacy = await collect(
    "python",
    { format: "$pyenv_prefix$virtualenv" },
    {
      environment: { PYENV_VERSION: "3.12", VIRTUAL_ENV: " \t ", CONDA_DEFAULT_ENV: "/envs/work" },
    },
  );
  assert.deepEqual(legacy.snapshot.modules.python, { pyenv_prefix: "3.12", virtualenv: "work" });
  assert.deepEqual(legacy.calls, []);
  for (const [generic, expected] of [
    [[], ".venv"],
    [[".venv"], "project"],
  ] as const) {
    const result = await collect(
      "python",
      { format: "$virtualenv", generic_venv_names: generic },
      {
        environment: { VIRTUAL_ENV: "/projects/project/.venv/" },
      },
    );
    assert.equal(result.snapshot.modules.python?.virtualenv, expected);
    assert.deepEqual(result.reads, []);
    assert.deepEqual(result.calls, []);
  }
});

test("generic environment names use only meaningful parent basenames", async () => {
  for (const [path, expected] of [
    ["project/.venv", "project"],
    [".venv", ".venv"],
    ["/.venv", ".venv"],
  ] as const) {
    const result = await collect(
      "python",
      { format: "$virtualenv", generic_venv_names: [".venv"] },
      {
        environment: { VIRTUAL_ENV: path },
      },
    );
    assert.equal(result.snapshot.modules.python?.virtualenv, expected);
  }
});

test.each([
  [[], { VIRTUAL_ENV: "/env" }, false, false],
  [["VIRTUAL_ENV"], { VIRTUAL_ENV: "/env" }, false, true],
  [["VIRTUAL_ENV"], { VIRTUAL_ENV: "" }, false, true],
  [["VIRTUAL_ENV"], {}, false, false],
  [["!BLOCKED"], {}, false, true],
  [["VIRTUAL_ENV", "!BLOCKED"], { VIRTUAL_ENV: "/env", BLOCKED: "" }, false, false],
  [["!BLOCKED"], { BLOCKED: "yes" }, true, true],
] as const)("Python env detection %j / %j / project=%s", async (names, environment, project, expected) => {
  const result = await collect(
    "python",
    { format: "$symbol", detect_env_vars: names },
    { environment, noMarker: !project },
  );
  assert.equal(result.snapshot.modules.python !== undefined, expected);
  assert.deepEqual(result.calls, []);
});

// npm-semver supports range alternatives, hyphen ranges, wildcards, and prerelease rules.
// Invalid/missing inputs fail open; this is not Rust semver grammar parity.
test.each([
  ["v22.1.0", ">=20 <23", true],
  ["v18.0.0", ">=20", false],
  ["v22.1.0", "^22.0.0", true],
  ["v23.0.0", "^22.0.0", false],
  ["v22.1.2", "~22.1.0", true],
  ["v22.2.0", "~22.1.0", false],
  ["v22.1.0", "18.x || 22.x", true],
  ["v20.0.0", "18.x || 22.x", false],
  ["v22.1.0", "20 - 22", true],
  ["v22.1.0", "*", true],
  ["v22.0.0-rc.1", ">=22", false],
  ["v22.0.0-rc.1", ">=22.0.0-rc.0 <23", true],
  [undefined, ">=22", true],
  ["v18.0.0", undefined, true],
  ["not-a-version", ">=22", true],
  ["v18.0.0", "bad range", true],
  ["v18.0.0", ">=22\n<23", true],
  ["v18.0.0", ">=22".repeat(100), true],
] as const)("Node requirement %s / %s", (version, requirement, expected) => {
  assert.equal(nodeRequirementSatisfied(version, requirement), expected);
});

test.each([
  ["v1.24.1", "1.24", true],
  ["v1.23.9", "1.24", false],
  ["v1.24", "1.24.1", false],
  ["v1.24", "1.24", true],
  ["v2.0.0", "1.24", true],
  ["v1.24rc1", "1.24", true],
  [undefined, "1.24", true],
  ["v1.24.0", undefined, true],
  ["bad", "1.24", true],
  ["v1.24.0", "bad", true],
] as const)("Go minimum requirement %s / %s", (version, requirement, expected) => {
  assert.equal(goRequirementSatisfied(version, requirement), expected);
});

test("Node requirements stay visible and opt-in incapable styling uses cached selectors", async () => {
  for (const [output, selector, color] of [
    ["v18.0.0", "not_capable", "red"],
    ["v22.0.0", undefined, "blue"],
  ] as const) {
    const result = await collect(
      "nodejs",
      {
        format: "[$version $engines_version]($style)",
        style: "blue",
        not_capable_style: "red",
      },
      { files: { "/work/package.json": '{"engines":{"node":">=20"}}' }, exec: async () => success(output) },
    );
    assert.equal(result.snapshot.modules.nodejs?.engines_version, ">=20");
    assert.equal(result.snapshot.styleSelectors?.nodejs, selector);
    assert.equal(result.snapshot.modules.nodejs?.__pi_style_selector, undefined);
    const before = [result.calls.length, result.reads.length];
    const rendered = renderStatusline(result.config, runtime(result.snapshot));
    assert.equal(rendered.modules.nodejs[0]?.style?.foreground?.kind, "named");
    assert.deepEqual(rendered.modules.nodejs[0]?.style?.foreground, { kind: "named", name: color });
    renderStatusline(result.config, runtime(result.snapshot));
    assert.deepEqual([result.calls.length, result.reads.length], before);
  }
});

test("empty incapable style is supported and Go disables toolchain downloads without mutating input", async () => {
  const environment = { GOTOOLCHAIN: "go1.99.0+auto" };
  const result = await collect(
    "golang",
    { format: "[$version]($style)", not_capable_style: "" },
    {
      environment,
      files: { "/work/go.mod": "go 1.24\n" },
      exec: async () => success("go version go1.23.0 linux/amd64"),
    },
  );
  assert.equal(result.snapshot.styleSelectors?.golang, "not_capable");
  assert.deepEqual(renderStatusline(result.config, runtime(result.snapshot)).modules.golang[0]?.style, {});
  assert.deepEqual(environment, { GOTOOLCHAIN: "go1.99.0+auto" });
});

test("Go reads only go directives, populates mod_version, and selects incapable style", async () => {
  const result = await collect(
    "golang",
    { format: "[$version $mod_version]($style)", not_capable_style: "red" },
    {
      files: {
        "/work/go.mod": "module example.test/go9.99\r\n// go 9.99\r\ngo 1.24.1 // minimum\r\ntoolchain go1.25.0\r\n",
      },
      exec: async () => success("go version go1.24 linux/amd64"),
    },
  );
  assert.equal(result.snapshot.modules.golang?.mod_version, "1.24.1");
  assert.equal(result.snapshot.styleSelectors?.golang, "not_capable");
  const compatible = await collect(
    "golang",
    { format: "$mod_version" },
    {
      files: { "/work/go.mod": "go 1.24\n" },
      exec: async () => success("go version go1.25 linux/amd64"),
    },
  );
  assert.deepEqual(compatible.snapshot.modules.golang, { mod_version: "1.24" });
  assert.deepEqual(compatible.calls, []);
  for (const source of ["// go 1.24", "module go1.24", "toolchain go1.24.0", "go invalid", "go 1.24 bad", ""]) {
    const invalid = await collect("golang", { format: "$mod_version" }, { files: { "/work/go.mod": source } });
    assert.equal(invalid.snapshot.modules.golang?.mod_version, undefined);
    assert.deepEqual(invalid.calls, []);
  }
});

test("default and symbol-only formats do not collect extra requirement commands or metadata", async () => {
  for (const name of ["nodejs", "golang"] as const) {
    const plain = await collect(
      name,
      {},
      { exec: async () => success(name === "nodejs" ? "v22.1.0" : "go version go1.24 linux/amd64") },
    );
    assert.equal(plain.calls.length, 1);
    assert.deepEqual(plain.reads, []);
    for (const format of ["$symbol", "[$symbol]($style)"]) {
      const symbol = await collect(name, { format, not_capable_style: "red" });
      assert.deepEqual(symbol.calls, []);
      assert.deepEqual(symbol.reads, []);
    }
  }
  const requirementOnly = await collect(
    "nodejs",
    { format: "$engines_version" },
    {
      files: { "/work/package.json": '{"engines":{"node":">=99"}}' },
    },
  );
  assert.deepEqual(requirementOnly.calls, []);
  assert.equal(requirementOnly.snapshot.modules.nodejs?.engines_version, ">=99");
  assert.equal(parseRuntimeVersion("python", "Python 3.13.2\nextra"), undefined);
});
