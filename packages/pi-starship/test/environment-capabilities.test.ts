import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";
import { parseDirenvStatus, parseMiseHealth } from "../src/runtime/development.js";
import { createFileSystem, detectEnvironment } from "../src/runtime/helpers.js";
import type { WorkspaceExec, WorkspaceRefreshInput } from "../src/runtime/types.js";
import { collectWorkspaceSnapshot } from "../src/runtime/workspace.js";

const success = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });

type EnvironmentModule =
  | "conda"
  | "direnv"
  | "gcloud"
  | "hostname"
  | "mise"
  | "nix_shell"
  | "package"
  | "pixi"
  | "terraform";

async function collect(
  name: EnvironmentModule,
  module: Record<string, unknown> = {},
  fixture: {
    environment?: Record<string, string | undefined>;
    files?: Record<string, string>;
    entries?: readonly string[];
    exec?: WorkspaceExec;
    signal?: AbortSignal;
  } = {},
) {
  const { config, diagnostics } = normalizeConfig({ format: `$${name}`, [name]: module });
  assert.deepEqual(diagnostics, []);
  const reads: string[] = [];
  const calls: [string, string[]][] = [];
  const input: WorkspaceRefreshInput = {
    cwd: "/work",
    config,
    environment: fixture.environment ?? {},
    homeDir: "/home/user",
    platform: "linux",
    hostname: "host.example",
    username: "user",
    signal: fixture.signal,
    fileSystem: {
      readFile: async (path, maxBytes) => {
        reads.push(path);
        assert.ok(maxBytes <= 65_536);
        return fixture.files?.[path];
      },
      readDirectory: async () =>
        (fixture.entries ?? []).map((entry) => ({ name: entry, isFile: true, isDirectory: false })),
      fileExists: async () => false,
    },
    exec: async (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.timeout, 2_000);
      assert.equal(options.maxOutputBytes, 65_536);
      assert.equal(options.signal, fixture.signal);
      assert.equal(options.environment, input.environment);
      return fixture.exec ? fixture.exec(command, args, options) : success("");
    },
  };
  const snapshot = await collectWorkspaceSnapshot(input);
  return { snapshot, calls, reads, config };
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

// Context::detect_env_vars: an empty list, negative veto, all-negative, and positive OR.
// Presence includes empty values; malformed names fail closed instead of reading arbitrary keys.
test.each([
  [[], {}, true],
  [["ON"], {}, false],
  [["ON"], { ON: undefined }, false],
  [["ON"], { ON: "" }, true],
  [["ON"], { ON: " \t " }, true],
  [["MISSING", "ON"], { ON: "1" }, true],
  [["!OFF"], {}, true],
  [["!OFF", "!OTHER"], {}, true],
  [["!OFF"], { OFF: "" }, false],
  [["ON", "!OFF"], { ON: "1" }, true],
  [["ON", "!OFF"], { ON: "1", OFF: "" }, false],
  [["ON", "!OFF"], {}, false],
  [["ON", "ON"], { ON: "" }, true],
  [[""], {}, false],
  [["!"], {}, false],
  [["!!OFF"], {}, false],
  [["A=B"], { "A=B": "1" }, false],
  [["ON\n"], { "ON\n": "1" }, false],
] as const)("environment detection %j / %j", (names, environment, expected) => {
  assert.equal(detectEnvironment(environment, names), expected);
});

test("environment detection ignores inherited values", () => {
  const environment = Object.create({ ON: "1" }) as Record<string, string>;
  assert.equal(detectEnvironment(environment, ["ON"]), false);
  assert.equal(detectEnvironment(environment, ["!ON"]), true);
});

test("Conda, gcloud, and hostname use optional env gates without changing their defaults", async () => {
  for (const name of ["conda", "gcloud", "hostname"] as const) {
    for (const [names, extra, expected] of [
      [[], {}, true],
      [["ON"], {}, false],
      [["ON"], { ON: "" }, true],
      [["!OFF"], {}, true],
      [["!OFF"], { OFF: "" }, false],
      [["ON", "!OFF"], { ON: "1", OFF: "1" }, false],
    ] as const) {
      const result = await collect(
        name,
        { detect_env_vars: names },
        {
          environment: {
            CONDA_DEFAULT_ENV: "work",
            CLOUDSDK_ACTIVE_CONFIG_NAME: "prod",
            SSH_CONNECTION: "ssh",
            ...extra,
          },
          files: { "/home/user/.config/gcloud/configurations/config_prod": "[core]\nproject=demo\n" },
        },
      );
      assert.equal(result.snapshot.modules[name] !== undefined, expected, `${name}: ${names}`);
      assert.deepEqual(result.calls, []);
      if (name === "gcloud" && !expected) assert.deepEqual(result.reads, []);
    }
  }
  const pixi = await collect(
    "conda",
    {},
    { environment: { CONDA_DEFAULT_ENV: "work", PIXI_ENVIRONMENT_NAME: "default" } },
  );
  assert.equal(pixi.snapshot.modules.conda?.environment, "work");
  const base = await collect("conda", {}, { environment: { CONDA_DEFAULT_ENV: "base" } });
  assert.equal(base.snapshot.modules.conda, undefined);
  const shownBase = await collect("conda", { ignore_base: false }, { environment: { CONDA_DEFAULT_ENV: "base" } });
  assert.equal(shownBase.snapshot.modules.conda?.environment, "base");
  for (const value of [undefined, "", " \t "]) {
    const empty = await collect("conda", {}, { environment: { CONDA_DEFAULT_ENV: value } });
    assert.equal(empty.snapshot.modules.conda, undefined);
  }
});

test("hostname env gates do not override ssh_only; ssh_symbol is configurable and pure", async () => {
  const hidden = await collect("hostname", { detect_env_vars: ["ON"] }, { environment: { ON: "1" } });
  assert.equal(hidden.snapshot.modules.hostname, undefined);
  const local = await collect("hostname", { ssh_only: false, ssh_symbol: "SSH " });
  assert.deepEqual(local.snapshot.modules.hostname, { hostname: "host", ssh_symbol: "" });
  const remote = await collect("hostname", { ssh_symbol: "remote \u001b[31m" }, { environment: { SSH_TTY: "tty" } });
  assert.equal(remote.snapshot.modules.hostname?.ssh_symbol, "remote \u001b[31m");
  const before = [remote.reads.length, remote.calls.length];
  const rendered = renderStatusline(remote.config, runtime(remote.snapshot));
  assert.equal(stripVTControlCharacters(rendered.ansi), "remote host in ");
  assert.deepEqual([remote.reads.length, remote.calls.length], before);
  const empty = await collect("hostname", { ssh_symbol: "" }, { environment: { SSH_CONNECTION: "ssh" } });
  assert.equal(empty.snapshot.modules.hostname?.ssh_symbol, "");
});

test("direnv preserves file detection and adds only explicit environment alternatives", async () => {
  for (const [names, environment, entries, expected] of [
    [[], { DIRENV_FILE: "path" }, [], false],
    [["DIRENV_FILE"], { DIRENV_FILE: "" }, [], true],
    [["DIRENV_FILE"], {}, [], false],
    [["!OFF"], {}, [], true],
    [["!OFF"], { OFF: "" }, [], false],
    [["DIRENV_FILE", "!OFF"], { DIRENV_FILE: "path", OFF: "" }, [".envrc"], true],
  ] as const) {
    const result = await collect("direnv", { format: "$symbol", detect_env_vars: names }, { environment, entries });
    assert.equal(result.snapshot.modules.direnv !== undefined, expected);
    assert.deepEqual(result.calls, []);
  }
});

const labels = { allowed: "YES", notAllowed: "WAIT", denied: "NO", loaded: "READY", unloaded: "PENDING" };
const rc = (allowed: number) => ({ path: "/work/.envrc", allowed });

// Actual direnv JSON uses state.foundRC/state.loadedRC and numeric 0/1/2 statuses.
test.each([
  [undefined, undefined, undefined, undefined],
  [0, undefined, "YES", "PENDING"],
  [1, undefined, "WAIT", "PENDING"],
  [2, undefined, "NO", "PENDING"],
  [0, 0, "YES", "READY"],
  [1, 0, "WAIT", "READY"],
  [2, 0, "NO", "READY"],
  [0, 1, "YES", "PENDING"],
  [0, 2, "YES", "PENDING"],
  [undefined, 0, undefined, undefined],
  [3, undefined, undefined, undefined],
  [0, 3, undefined, undefined],
] as const)("direnv state found=%s loaded=%s", (found, loaded, allowedLabel, loadedLabel) => {
  const output = JSON.stringify({
    state: { foundRC: found === undefined ? null : rc(found), loadedRC: loaded === undefined ? null : rc(loaded) },
  });
  const values = parseDirenvStatus(output, labels);
  assert.equal(values.allowed, allowedLabel);
  assert.equal(values.loaded, loadedLabel);
  assert.equal(values.rc_path, allowedLabel ? "/work/.envrc" : undefined);
});

test("direnv preserves Pi's legacy top-level boolean and 0/1 branches", () => {
  for (const [allowed, expected] of [
    [true, "YES"],
    [1, "YES"],
    [false, "NO"],
    [0, "NO"],
  ] as const) {
    const loaded = parseDirenvStatus(
      JSON.stringify({ foundRC: { path: "/work/.envrc", allowed }, loadedRC: {} }),
      labels,
    );
    assert.deepEqual(loaded, { rc_path: "/work/.envrc", allowed: expected, loaded: "READY" });
    const unloaded = parseDirenvStatus(JSON.stringify({ foundRC: { path: "/work/.envrc", allowed } }), labels);
    assert.equal(unloaded.loaded, "PENDING");
  }
});

test.each([
  ["0", "YES"],
  ["true", "YES"],
  ["1", "WAIT"],
  ["2", "NO"],
  ["false", "NO"],
] as const)("direnv legacy text allow status %s", (allowed, expected) => {
  const prefix = `Found RC path /work/.envrc\nFound RC allowed ${allowed}\n`;
  assert.deepEqual(parseDirenvStatus(prefix, labels), { rc_path: "/work/.envrc", allowed: expected, loaded: "READY" });
  assert.equal(parseDirenvStatus(`${prefix}No .envrc or .env loaded\n`, labels).loaded, "PENDING");
});

test("direnv messages include empty strings and malformed state stays inert", async () => {
  const result = await collect(
    "direnv",
    {
      format: "$rc_path$allowed$loaded",
      allowed_msg: "ok",
      not_allowed_msg: "pending",
      denied_msg: "blocked",
      loaded_msg: "active",
      unloaded_msg: "",
    },
    { entries: [".envrc"], exec: async () => success(JSON.stringify({ state: { foundRC: rc(1), loadedRC: null } })) },
  );
  assert.deepEqual(result.snapshot.modules.direnv, { rc_path: "/work/.envrc", allowed: "pending", loaded: "" });
  assert.deepEqual(result.calls, [["direnv", ["status", "--json"]]]);
  for (const output of [
    "{}",
    "null",
    "[]",
    "{",
    '{"state":null}',
    '{"state":{"foundRC":{"allowed":0}}}',
    '{"state":{"foundRC":{"allowed":"0","path":"/rc"}}}',
    "No .envrc or .env loaded",
  ]) {
    assert.deepEqual(parseDirenvStatus(output, labels), {});
  }
  assert.deepEqual(parseDirenvStatus("Found RC path /work/.envrc\n"), { rc_path: "/work/.envrc" });
  assert.deepEqual(parseDirenvStatus(JSON.stringify({ state: { foundRC: rc(0) } }), { allowed: "", unloaded: "" }), {
    rc_path: "/work/.envrc",
    allowed: "",
    loaded: "",
  });
});

test.each([
  ["all checks passed", "healthy"],
  ["healthy", "healthy"],
  ["no problems found", "healthy"],
  ["unhealthy", "issues"],
  ["error", "issues"],
  ["problem", "issues"],
  ["warning", "issues"],
  ["", undefined],
  ["version 1", undefined],
] as const)("mise health branch %j", (output, expected) => assert.equal(parseMiseHealth(output), expected));

test("mise maps parsed health to configurable symbols without changing default failure behavior", async () => {
  for (const [output, expected] of [
    ["healthy", "good "],
    ["unhealthy", "bad "],
  ] as const) {
    const result = await collect(
      "mise",
      { healthy_symbol: "good ", unhealthy_symbol: "bad " },
      {
        entries: ["mise.toml"],
        exec: async () => success(output),
      },
    );
    assert.equal(result.snapshot.modules.mise?.health, expected);
    assert.deepEqual(result.calls, [["mise", ["doctor"]]]);
  }
  const empty = await collect(
    "mise",
    { unhealthy_symbol: "" },
    { entries: ["mise.toml"], exec: async () => success("warning") },
  );
  assert.equal(empty.snapshot.modules.mise?.health, "");
  const failure = await collect(
    "mise",
    {},
    { entries: ["mise.toml"], exec: async () => ({ ...success("error"), code: 1 }) },
  );
  assert.deepEqual(failure.snapshot.modules.mise, {});
  const absent = await collect("mise");
  assert.deepEqual(absent.calls, []);
});

test("Nix messages preserve pure/impure activation and do not enable PATH heuristics", async () => {
  for (const [state, expected] of [
    ["pure", "clean"],
    ["impure", "dirty"],
  ] as const) {
    const result = await collect(
      "nix_shell",
      { pure_msg: "clean", impure_msg: "dirty" },
      {
        environment: { IN_NIX_SHELL: state, NIX_SHELL_NAME: "dev", NIX_SHELL_LEVEL: "2" },
      },
    );
    assert.deepEqual(result.snapshot.modules.nix_shell, { state: expected, name: "dev", level: "2" });
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.reads, []);
  }
  for (const state of [undefined, "", "unknown", "invalid"]) {
    const result = await collect("nix_shell", {}, { environment: { IN_NIX_SHELL: state, PATH: "/nix/store/bin" } });
    assert.equal(result.snapshot.modules.nix_shell, undefined);
  }
  const empty = await collect("nix_shell", { pure_msg: "" }, { environment: { IN_NIX_SHELL: "pure" } });
  assert.equal(empty.snapshot.modules.nix_shell?.state, "");
});

test("configured environment messages render as literal sanitized text without new I/O", async () => {
  for (const name of ["direnv", "mise", "nix_shell"] as const) {
    const label = "safe\u001b[31m$version\u0007";
    const result = await collect(
      name,
      {
        format: name === "direnv" ? "$allowed" : name === "mise" ? "$health" : "$state",
        ...(name === "direnv"
          ? { allowed_msg: label }
          : name === "mise"
            ? { healthy_symbol: label }
            : { pure_msg: label }),
      },
      {
        entries: name === "direnv" ? [".envrc"] : ["mise.toml"],
        environment: { IN_NIX_SHELL: "pure" },
        exec: async () => success(name === "direnv" ? JSON.stringify({ state: { foundRC: rc(0) } }) : "healthy"),
      },
    );
    const before = [result.calls.length, result.reads.length];
    const rendered = renderStatusline(result.config, runtime(result.snapshot));
    assert.equal(stripVTControlCharacters(rendered.ansi).trim(), "safe$version");
    assert.ok(
      rendered.chunks.every((chunk) =>
        Array.from(chunk.text).every((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code > 0x1f && (code < 0x7f || code > 0x9f);
        }),
      ),
    );
    assert.deepEqual([result.calls.length, result.reads.length], before);
  }
});

test("environment commands stop on cancellation without publishing stale labels", async () => {
  const controller = new AbortController();
  const result = await collect(
    "direnv",
    {},
    {
      signal: controller.signal,
      entries: [".envrc"],
      exec: async () => {
        controller.abort();
        return success(JSON.stringify({ state: { foundRC: rc(0) } }));
      },
    },
  );
  assert.deepEqual(result.snapshot.modules, {});
  assert.deepEqual(result.calls, [["direnv", ["status", "--json"]]]);
});

test("package display_private defaults to current visibility and checks only a boolean private flag", async () => {
  for (const [privateValue, visible] of [
    [true, false],
    [false, true],
    ["true", true],
    [null, true],
  ] as const) {
    const files = { "/work/package.json": JSON.stringify({ version: "1.2.3", private: privateValue }) };
    const defaults = await collect("package", {}, { files });
    assert.equal(defaults.snapshot.modules.package?.version, "v1.2.3");
    const explicit = await collect("package", { display_private: true }, { files });
    assert.equal(explicit.snapshot.modules.package?.version, "v1.2.3");
    const hidden = await collect("package", { display_private: false }, { files });
    assert.equal(hidden.snapshot.modules.package !== undefined, visible);
    assert.deepEqual(hidden.calls, []);
  }
});

test("private package suppression retains manifest precedence and does not invent Cargo/Python privacy fields", async () => {
  const cargo = await collect(
    "package",
    { display_private: false },
    {
      files: {
        "/work/package.json": '{"private":true,"version":"1.0.0"}',
        "/work/Cargo.toml": '[package]\nversion="2.0.0"\npublish=false\n',
      },
    },
  );
  assert.deepEqual(cargo.snapshot.modules.package, { source: "Cargo.toml", version: "v2.0.0" });
  const python = await collect(
    "package",
    { display_private: false },
    {
      files: { "/work/pyproject.toml": '[project]\nversion="3.0.0"\nprivate=true\n' },
    },
  );
  assert.deepEqual(python.snapshot.modules.package, { source: "pyproject.toml (PEP 621)", version: "v3.0.0" });
});

function nativeInput(cwd: string): WorkspaceRefreshInput {
  return {
    cwd,
    config: normalizeConfig({ format: "$model" }).config,
    environment: {},
    homeDir: cwd,
    platform: process.platform,
    hostname: "host",
    username: "user",
    exec: async () => {
      throw new Error("unexpected command");
    },
  };
}

test("native metadata helpers bound regular files and provide lazy path/permission readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-starship-native-metadata-"));
  try {
    const fs = createFileSystem(nativeInput(root));
    const file = join(root, "file");
    await writeFile(file, "0123456789");
    assert.equal(await fs.readFile(file, 10), "0123456789");
    assert.equal(await fs.readFile(file, 9), undefined);
    assert.equal(await fs.readFile(root, 10), undefined);
    assert.equal(await fs.readFile(join(root, "missing"), 10), undefined);
    await writeFile(file, "");
    assert.equal(await fs.readFile(file, 10), "");
    assert.equal(await fs.isWritable?.(root), true);
    assert.equal(await fs.isWritable?.(join(root, "missing")), undefined);
    assert.equal(await fs.realPath?.(join(root, "missing")), undefined);
    if (process.platform !== "win32") {
      const link = join(root, "link");
      await symlink(file, link);
      const physical = await fs.realPath?.(file);
      assert.equal(typeof physical, "string");
      assert.equal(await fs.realPath?.(link), physical);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "native reader handles zero-size procfs files without truncation",
  async () => {
    const path = "/proc/self/status";
    assert.equal((await stat(path)).size, 0);
    const fs = createFileSystem(nativeInput("/"));
    const content = await fs.readFile(path, 65_536);
    assert.match(content ?? "", /^Name:/u);
    assert.match(content ?? "", /^Pid:/mu);
    assert.equal(await fs.readFile(path, 1), undefined);
  },
);

test("package, Pixi, and Terraform use the same component and braced version grammar", async () => {
  for (const [name, fixture] of [
    ["package", { files: { "/work/package.json": '{"version":"1.2.3-beta.1"}' } }],
    ["pixi", { entries: ["pixi.toml"], exec: async () => success("pixi 1.2.3-beta.1") }],
    ["terraform", { entries: ["main.tf"], exec: async () => success("Terraform v1.2.3-beta.1") }],
  ] as const) {
    const result = await collect(
      name,
      { format: "$version", version_format: `\${major}:$minor:$patch:\${raw}` },
      fixture,
    );
    assert.equal(result.snapshot.modules[name]?.version, "1:2:3:1.2.3-beta.1");
  }
});
