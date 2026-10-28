import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { normalizeConfig, validateConfigDocument } from "../src/config.js";
import { serializeEffectiveConfig } from "../src/effective-config.js";
import { parseStyle } from "../src/format/style.js";
import { inspectStatuslineModules } from "../src/modules/inspection.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot, WorkspaceSnapshot } from "../src/modules/types.js";
import { MAX_METADATA_FILE_BYTES } from "../src/runtime/helpers.js";
import { PRIVATE_STYLE_SELECTOR, type WorkspaceEntry, type WorkspaceRefreshInput } from "../src/runtime/types.js";
import { collectWorkspaceSnapshot } from "../src/runtime/workspace.js";

const DEFAULT_CONFIG = "/home/test/.kube/config";

function kubeconfig(context: Record<string, unknown> = {}, document: Record<string, unknown> = {}): string {
  return JSON.stringify({
    "current-context": "prod",
    contexts: [{ name: "prod", context: { cluster: "cluster", user: "alice", ...context } }],
    clusters: [{ name: "cluster", cluster: { server: "https://never-contact.invalid" } }],
    users: [{ name: "alice", user: {} }],
    ...document,
  });
}

function file(name: string): WorkspaceEntry {
  return { name, isFile: true, isDirectory: false };
}

function folder(name: string): WorkspaceEntry {
  return { name, isFile: false, isDirectory: true };
}

interface FixtureOptions {
  options?: Record<string, unknown>;
  environment?: Record<string, string | undefined>;
  entries?: readonly WorkspaceEntry[];
  files?: Readonly<Record<string, string | undefined>>;
  rootFormat?: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  readFile?(path: string): Promise<string | undefined>;
  readDirectory?(): Promise<readonly WorkspaceEntry[]>;
}

async function collect(options: FixtureOptions = {}) {
  const loaded = normalizeConfig({
    format: options.rootFormat ?? "$kubernetes",
    kubernetes: options.options ?? {},
  });
  const reads: { path: string; maxBytes: number }[] = [];
  const scans: string[] = [];
  const commands: string[] = [];
  const probes: string[] = [];
  const files = options.files ?? { [DEFAULT_CONFIG]: kubeconfig() };
  const input: WorkspaceRefreshInput = {
    cwd: "/project",
    config: loaded.config,
    homeDir: "/home/test",
    environment: options.environment ?? {},
    platform: options.platform ?? "linux",
    hostname: "host",
    username: "user",
    signal: options.signal,
    exec: async (command) => {
      commands.push(command);
      throw new Error("Kubernetes must not run a command");
    },
    fileSystem: {
      async readFile(path, maxBytes) {
        reads.push({ path, maxBytes });
        const source = options.readFile ? await options.readFile(path) : files[path];
        return source !== undefined && Buffer.byteLength(source) <= maxBytes ? source : undefined;
      },
      async readDirectory(path) {
        scans.push(path);
        return options.readDirectory ? options.readDirectory() : (options.entries ?? []);
      },
      async fileExists(path) {
        probes.push(path);
        return false;
      },
    },
  };
  const snapshot = await collectWorkspaceSnapshot(input);
  assert.deepEqual(commands, []);
  assert.deepEqual(probes, []);
  assert.ok(reads.every(({ maxBytes }) => maxBytes === MAX_METADATA_FILE_BYTES));
  return { ...loaded, snapshot, reads, scans, commands, probes };
}

function runtime(workspace: WorkspaceSnapshot): StarshipRuntimeSnapshot {
  return {
    cwd: "/project",
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

// Source contract: Starship ae8fecf3 modules/kubernetes.rs and context/mod.rs.
// Pi retains its default namespace, exact legacy aliases, named-user/cluster
// checks, enabled state, and footer format rather than claiming full parity.
test("Kubernetes keeps its no-override defaults and reads no directory", async () => {
  const result = await collect();
  assert.deepEqual(result.diagnostics, []);
  for (const field of ["detect_files", "detect_extensions", "detect_folders", "detect_env_vars", "contexts"]) {
    assert.deepEqual(result.config.modules.kubernetes.options[field], []);
  }
  assert.equal(result.config.modules.kubernetes.disabled, false);
  assert.equal(result.config.modules.kubernetes.symbol, "☸ ");
  assert.equal(result.config.modules.kubernetes.style, "cyan bold");
  assert.deepEqual(result.snapshot.modules.kubernetes, {
    context: "prod",
    namespace: "default",
    cluster: "cluster",
    user: "alice",
  });
  assert.equal(result.snapshot.styleSelectors, undefined);
  assert.deepEqual(result.scans, []);
  assert.deepEqual(
    result.reads.map(({ path }) => path),
    [DEFAULT_CONFIG],
  );
  const rendered = renderStatusline(result.config, runtime(result.snapshot));
  assert.equal(stripVTControlCharacters(rendered.ansi), "on ☸ prod (default) ");
});

test.each([
  { name: "disabled", options: { disabled: true }, rootFormat: "$kubernetes" },
  { name: "unreachable", options: {}, rootFormat: "$brand" },
  { name: "empty root", options: {}, rootFormat: "" },
])("Kubernetes does no work when $name", async ({ options, rootFormat }) => {
  const result = await collect({ options, rootFormat });
  assert.equal(result.snapshot.modules.kubernetes, undefined);
  assert.deepEqual(result.reads, []);
  assert.deepEqual(result.scans, []);
});

test.each([
  { name: "exact file", options: { detect_files: ["kube.yaml"] }, entries: [file("kube.yaml")], detected: true },
  {
    name: "folder is not a file",
    options: { detect_files: ["kube.yaml"] },
    entries: [folder("kube.yaml")],
    detected: false,
  },
  {
    name: "nonregular entries are not followed",
    options: { detect_files: ["kube.yaml"], detect_extensions: ["yaml"], detect_folders: ["kube.yaml"] },
    entries: [{ name: "kube.yaml", isFile: false, isDirectory: false }],
    detected: false,
  },
  {
    name: "file names are literal",
    options: { detect_files: ["*.yaml"] },
    entries: [file("kube.yaml")],
    detected: false,
  },
  {
    name: "no recursive file scan",
    options: { detect_files: ["nested/kube.yaml"] },
    entries: [folder("nested")],
    detected: false,
  },
  { name: "last extension", options: { detect_extensions: ["yaml"] }, entries: [file("kube.yaml")], detected: true },
  {
    name: "compound extension",
    options: { detect_extensions: ["tar.gz"] },
    entries: [file("chart.tar.gz")],
    detected: true,
  },
  {
    name: "compound last extension",
    options: { detect_extensions: ["gz"] },
    entries: [file("chart.tar.gz")],
    detected: true,
  },
  {
    name: "not an intermediate extension",
    options: { detect_extensions: ["tar"] },
    entries: [file("chart.tar.gz")],
    detected: false,
  },
  {
    name: "hidden extensions ignored",
    options: { detect_extensions: ["yaml"] },
    entries: [file(".hidden.yaml")],
    detected: false,
  },
  { name: "hidden file exact match", options: { detect_files: [".kube"] }, entries: [file(".kube")], detected: true },
  {
    name: "no leading extension dot",
    options: { detect_extensions: [".yaml"] },
    entries: [file("kube.yaml")],
    detected: false,
  },
  {
    name: "extension requires file",
    options: { detect_extensions: ["yaml"] },
    entries: [folder("kube.yaml")],
    detected: false,
  },
  { name: "no extension", options: { detect_extensions: ["yaml"] }, entries: [file("kube")], detected: false },
  { name: "empty extension", options: { detect_extensions: ["yaml"] }, entries: [file("kube.")], detected: false },
  { name: "exact folder", options: { detect_folders: ["k8s"] }, entries: [folder("k8s")], detected: true },
  { name: "file is not a folder", options: { detect_folders: ["k8s"] }, entries: [file("k8s")], detected: false },
  { name: "unmatched", options: { detect_files: ["kube.yaml"] }, entries: [], detected: false },
  {
    name: "positive alternatives",
    options: { detect_files: ["missing"], detect_folders: ["k8s"] },
    entries: [folder("k8s")],
    detected: true,
  },
  {
    name: "negative file veto",
    options: { detect_files: ["!skip"], detect_extensions: ["yaml"] },
    entries: [file("kube.yaml"), file("skip")],
    detected: false,
  },
  {
    name: "negative extension veto",
    options: { detect_files: ["kube.yaml"], detect_extensions: ["!gz"] },
    entries: [file("kube.yaml"), file("chart.tar.gz")],
    detected: false,
  },
  {
    name: "negative compound extension veto",
    options: { detect_files: ["kube.yaml"], detect_extensions: ["!tar.gz"] },
    entries: [file("kube.yaml"), file("chart.tar.gz")],
    detected: false,
  },
  {
    name: "negative folder veto",
    options: { detect_files: ["kube.yaml"], detect_folders: ["!skip"] },
    entries: [file("kube.yaml"), folder("skip")],
    detected: false,
  },
  {
    name: "negative file does not veto folder",
    options: { detect_files: ["!skip"], detect_folders: ["skip"] },
    entries: [folder("skip")],
    detected: true,
  },
  { name: "negative only absent", options: { detect_files: ["!skip"] }, entries: [], detected: false },
  { name: "negative only present", options: { detect_files: ["!skip"] }, entries: [file("skip")], detected: false },
])("Kubernetes directory detection: $name", async ({ options, entries, detected }) => {
  const result = await collect({ options, entries });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(Boolean(result.snapshot.modules.kubernetes), detected);
  assert.deepEqual(result.scans, ["/project"]);
  assert.equal(result.reads.length, detected ? 1 : 0);
});

test.each([
  { name: "empty detectors", variables: [], environment: {}, detected: true },
  { name: "missing positive", variables: ["KUBE_MODE"], environment: {}, detected: false },
  { name: "undefined positive", variables: ["KUBE_MODE"], environment: { KUBE_MODE: undefined }, detected: false },
  {
    name: "inherited positive ignored",
    variables: ["KUBE_MODE"],
    environment: Object.create({ KUBE_MODE: "yes" }) as Record<string, string>,
    detected: false,
  },
  { name: "invalid environment name", variables: ["KUBE-MODE"], environment: { "KUBE-MODE": "yes" }, detected: false },
  { name: "empty negated name", variables: ["!"], environment: {}, detected: false },
  { name: "empty positive is present", variables: ["KUBE_MODE"], environment: { KUBE_MODE: "" }, detected: true },
  { name: "nonempty positive", variables: ["KUBE_MODE"], environment: { KUBE_MODE: "yes" }, detected: true },
  {
    name: "positive alternatives",
    variables: ["MISSING", "KUBE_MODE"],
    environment: { KUBE_MODE: "yes" },
    detected: true,
  },
  { name: "negative absent", variables: ["!KUBE_HIDE"], environment: {}, detected: true },
  { name: "all negatives absent", variables: ["!KUBE_HIDE", "!OTHER_HIDE"], environment: {}, detected: true },
  { name: "negative present", variables: ["!KUBE_HIDE"], environment: { KUBE_HIDE: "yes" }, detected: false },
  { name: "empty negative is present", variables: ["!KUBE_HIDE"], environment: { KUBE_HIDE: "" }, detected: false },
  {
    name: "negative vetoes positive",
    variables: ["KUBE_MODE", "!KUBE_HIDE"],
    environment: { KUBE_MODE: "yes", KUBE_HIDE: "yes" },
    detected: false,
  },
  {
    name: "negative absent still needs positive",
    variables: ["KUBE_MODE", "!KUBE_HIDE"],
    environment: {},
    detected: false,
  },
])("Kubernetes environment detection: $name", async ({ variables, environment, detected }) => {
  const result = await collect({ options: { detect_env_vars: variables }, environment });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(Boolean(result.snapshot.modules.kubernetes), detected);
  assert.deepEqual(result.scans, []);
  assert.equal(result.reads.length, detected ? 1 : 0);
});

test.each([
  {
    name: "unmatched scan overrides matched env",
    entries: [],
    environment: { KUBE_MODE: "yes" },
    variables: ["KUBE_MODE"],
    detected: false,
  },
  {
    name: "matched scan overrides missing env",
    entries: [file("kube.yaml")],
    environment: {},
    variables: ["KUBE_MODE"],
    detected: true,
  },
  {
    name: "matched scan overrides negative env",
    entries: [file("kube.yaml")],
    environment: { KUBE_HIDE: "" },
    variables: ["!KUBE_HIDE"],
    detected: true,
  },
])("Kubernetes detector precedence: $name", async ({ entries, environment, variables, detected }) => {
  const result = await collect({
    options: { detect_files: ["kube.yaml"], detect_env_vars: variables },
    entries,
    environment,
  });
  assert.equal(Boolean(result.snapshot.modules.kubernetes), detected);
  assert.deepEqual(result.scans, ["/project"]);
});

test.each([
  {
    name: "exact context",
    contexts: [{ context_pattern: "prod", context_alias: "production" }],
    expected: "production",
  },
  {
    name: "regex context",
    contexts: [{ context_pattern: "pr.*", context_alias: "production" }],
    expected: "production",
  },
  { name: "whole context required", contexts: [{ context_pattern: "pr", context_alias: "wrong" }], expected: "prod" },
  {
    name: "empty context pattern is not wildcard",
    contexts: [{ context_pattern: "", context_alias: "wrong" }],
    expected: "prod",
  },
  {
    name: "first matching rule",
    contexts: [
      { context_pattern: "pr.*", context_alias: "first" },
      { context_pattern: "prod", context_alias: "second" },
    ],
    expected: "first",
  },
  {
    name: "first matching rule with no overrides",
    contexts: [{ context_pattern: "prod" }, { context_pattern: "prod", context_alias: "wrong" }],
    expected: "prod",
  },
  {
    name: "skip context mismatch",
    contexts: [
      { context_pattern: "dev", user_pattern: "alice", context_alias: "wrong" },
      { context_pattern: "prod", context_alias: "next" },
    ],
    expected: "next",
  },
  {
    name: "both patterns match",
    contexts: [{ context_pattern: "pr.*", user_pattern: "ali.*", context_alias: "both", user_alias: "operator" }],
    expected: "both",
    expectedUser: "operator",
  },
  {
    name: "context match alone not enough",
    contexts: [
      { context_pattern: "prod", user_pattern: "bob", context_alias: "wrong" },
      { context_pattern: "prod", context_alias: "next" },
    ],
    expected: "next",
  },
  {
    name: "user match alone not enough",
    contexts: [{ context_pattern: "dev", user_pattern: "alice", context_alias: "wrong" }],
    expected: "prod",
  },
  {
    name: "whole user required",
    contexts: [{ context_pattern: "prod", user_pattern: "ali", context_alias: "wrong" }],
    expected: "prod",
  },
  {
    name: "numeric capture",
    contexts: [{ context_pattern: "pr(od)", context_alias: "cluster-$1" }],
    expected: "cluster-od",
  },
  {
    name: "named capture",
    contexts: [{ context_pattern: "pr(?P<suffix>od)", context_alias: "cluster-$suffix" }],
    expected: "cluster-od",
  },
  {
    name: "braced named capture",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Rust-style capture fields are literal alias inputs.
    contexts: [{ context_pattern: "pr(?P<suffix>od)", context_alias: "cluster-${suffix}" }],
    expected: "cluster-od",
  },
  {
    name: "anchored replacement alternatives",
    contexts: [{ context_pattern: "p|prod", context_alias: "complete" }],
    expected: "complete",
  },
  {
    name: "user capture",
    contexts: [{ context_pattern: "prod", user_pattern: "ali(ce)", user_alias: "operator-$1" }],
    expected: "prod",
    expectedUser: "operator-ce",
  },
  {
    name: "exact context replacement is literal",
    contexts: [{ context_pattern: "prod", context_alias: "$1" }],
    expected: "$1",
  },
  {
    name: "exact user replacement is literal",
    contexts: [{ context_pattern: "prod", user_pattern: "alice", user_alias: "$1" }],
    expected: "prod",
    expectedUser: "$1",
  },
  { name: "empty context alias", contexts: [{ context_pattern: "prod", context_alias: "" }], expected: "" },
  {
    name: "empty user alias",
    contexts: [{ context_pattern: "prod", user_alias: "" }],
    expected: "prod",
    expectedUser: "",
  },
])("Kubernetes context rules: $name", async ({ contexts, expected, expectedUser }) => {
  const result = await collect({ options: { contexts } });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.modules.kubernetes?.context, expected);
  assert.equal(result.snapshot.modules.kubernetes?.user, expectedUser ?? "alice");
});

test("Kubernetes exact regex-metacharacter labels keep alias captures literal", async () => {
  const result = await collect({
    options: { contexts: [{ context_pattern: "prod.example", context_alias: "$1" }] },
    files: { [DEFAULT_CONFIG]: kubeconfig({}, { "current-context": "prod.example" }) },
  });
  assert.equal(result.snapshot.modules.kubernetes?.context, "$1");
});

test.each(["context", "user"] as const)("Kubernetes supports the 512-character %s pattern boundary", async (field) => {
  const pattern = `${field === "context" ? "p" : "a"}${"(?:)".repeat(127)}${field === "context" ? "r.*" : "l.*"}`;
  assert.equal(pattern.length, 512);
  const rule =
    field === "context"
      ? { context_pattern: pattern, context_alias: "bounded" }
      : { context_pattern: "prod", user_pattern: pattern, user_alias: "bounded" };
  const result = await collect({ options: { contexts: [rule] } });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.modules.kubernetes?.[field], "bounded");
});

test("Kubernetes accepts exactly 64 ordered rules and reaches the last one", async () => {
  const contexts = [
    ...Array.from({ length: 63 }, (_, index) => ({ context_pattern: `missing-${index}` })),
    { context_pattern: "prod", context_alias: "last" },
  ];
  const result = await collect({ options: { contexts } });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.modules.kubernetes?.context, "last");
});

test("Kubernetes sanitizes rule aliases before truncating labels and keeps raw settings", async () => {
  const attack = "\u001b]52;c;secret\u0007";
  const contextAlias = `${attack}${"x".repeat(200)}`;
  const result = await collect({
    options: {
      contexts: [
        {
          context_pattern: "prod",
          context_alias: contextAlias,
          user_alias: `${attack}operator`,
        },
      ],
    },
  });
  assert.equal(result.snapshot.modules.kubernetes?.context, "x".repeat(160));
  assert.equal(result.snapshot.modules.kubernetes?.user, "operator");
  assert.deepEqual(result.config.modules.kubernetes.options.contexts, [
    {
      context_pattern: "prod",
      context_alias: contextAlias,
      user_alias: `${attack}operator`,
    },
  ]);
});

test.each([
  {
    name: "no user pattern can supply missing user",
    rule: { context_pattern: "prod", user_alias: "display-only" },
    expectedContext: "prod",
    expectedUser: "display-only",
  },
  {
    name: "missing user cannot match explicit pattern",
    rule: { context_pattern: "prod", user_pattern: ".*", context_alias: "wrong", user_alias: "wrong" },
    expectedContext: "prod",
    expectedUser: undefined,
  },
  {
    name: "missing user needs no alias",
    rule: { context_pattern: "prod", context_alias: "production" },
    expectedContext: "production",
    expectedUser: undefined,
  },
])("Kubernetes missing-user rule branch: $name", async ({ rule, expectedContext, expectedUser }) => {
  const result = await collect({
    options: { contexts: [rule] },
    files: { [DEFAULT_CONFIG]: kubeconfig({ user: undefined }) },
  });
  assert.equal(result.snapshot.modules.kubernetes?.context, expectedContext);
  assert.equal(result.snapshot.modules.kubernetes?.user, expectedUser);
});

test("Kubernetes preserves named-user/cluster defaults while rules use context user names", async () => {
  const files = { [DEFAULT_CONFIG]: kubeconfig({}, { users: [], clusters: [] }) };
  const baseline = await collect({ files });
  assert.deepEqual(baseline.snapshot.modules.kubernetes, { context: "prod", namespace: "default" });
  const matched = await collect({
    files,
    options: { contexts: [{ context_pattern: "prod", user_pattern: "alice", user_alias: "operator" }] },
  });
  assert.deepEqual(matched.snapshot.modules.kubernetes, { context: "prod", namespace: "default", user: "operator" });
});

test("Kubernetes legacy aliases stay exact and apply after context-rule aliases", async () => {
  const result = await collect({
    options: {
      contexts: [{ context_pattern: "prod", context_alias: "production", user_alias: "operator" }],
      context_aliases: { prod: "raw-is-not-selected", production: "final-context" },
      user_aliases: { alice: "raw-is-not-selected", operator: "final-user" },
      namespace_aliases: { default: "final-namespace" },
      cluster_aliases: { cluster: "final-cluster" },
    },
  });
  assert.deepEqual(result.snapshot.modules.kubernetes, {
    context: "final-context",
    user: "final-user",
    namespace: "final-namespace",
    cluster: "final-cluster",
  });
  const noRegex = await collect({ options: { context_aliases: { ".*": "wrong" }, user_aliases: { ".*": "wrong" } } });
  assert.equal(noRegex.snapshot.modules.kubernetes?.context, "prod");
  assert.equal(noRegex.snapshot.modules.kubernetes?.user, "alice");
});

test.each([
  { name: "no current context", source: kubeconfig({}, { "current-context": undefined }), expected: undefined },
  { name: "empty current context", source: kubeconfig({}, { "current-context": "" }), expected: undefined },
  {
    name: "unknown current context",
    source: kubeconfig({}, { "current-context": "unknown" }),
    expected: { context: "unknown", namespace: "default" },
  },
  {
    name: "missing context components",
    source: kubeconfig({}, { contexts: [] }),
    expected: { context: "prod", namespace: "default" },
  },
  {
    name: "malformed components",
    source: kubeconfig({ namespace: {}, user: 42, cluster: [] }),
    expected: { context: "prod", namespace: "default" },
  },
  { name: "non-object document", source: "[]", expected: undefined },
  { name: "malformed yaml", source: "contexts: [", expected: undefined },
  {
    name: "yaml document",
    source: "current-context: prod\ncontexts:\n  - name: prod\n    context:\n      namespace: ops\n",
    expected: { context: "prod", namespace: "ops" },
  },
])("Kubernetes kubeconfig branch: $name", async ({ source, expected }) => {
  const result = await collect({ files: { [DEFAULT_CONFIG]: source } });
  assert.deepEqual(result.snapshot.modules.kubernetes, expected);
});

test.each(["linux", "win32"] as const)(
  "Kubernetes merges bounded %s kubeconfig paths with first-key precedence",
  async (platform) => {
    const separator = platform === "win32" ? ";" : ":";
    const paths = ["/malformed", "/current", "/first", "/second"];
    const result = await collect({
      platform,
      environment: { KUBECONFIG: paths.join(separator) },
      files: {
        "/malformed": "current-context: [",
        "/current": JSON.stringify({ "current-context": "prod" }),
        "/first": kubeconfig({ namespace: "first", user: undefined }, { "current-context": "dev" }),
        "/second": kubeconfig({ namespace: "second", user: "alice" }),
      },
    });
    assert.equal(result.snapshot.modules.kubernetes?.context, "prod");
    assert.equal(result.snapshot.modules.kubernetes?.namespace, "first");
    assert.equal(result.snapshot.modules.kubernetes?.user, undefined);
    assert.deepEqual(
      result.reads.map(({ path }) => path),
      paths,
    );
  },
);

test("Kubernetes finds components before the file that selects the current context", async () => {
  const result = await collect({
    environment: { KUBECONFIG: "/components:/current" },
    files: {
      "/components": kubeconfig({ namespace: "from-components" }, { "current-context": undefined }),
      "/current": JSON.stringify({ "current-context": "prod" }),
    },
  });
  assert.equal(result.snapshot.modules.kubernetes?.namespace, "from-components");
});

test("Kubernetes limits files and ignores missing or oversized metadata independently", async () => {
  const result = await collect({
    options: { max_config_files: 3 },
    environment: { KUBECONFIG: "/missing:/oversized:/valid:/ignored" },
    files: {
      "/oversized": " ".repeat(MAX_METADATA_FILE_BYTES + 1),
      "/valid": kubeconfig(),
      "/ignored": kubeconfig({ namespace: "wrong" }),
    },
  });
  assert.equal(result.snapshot.modules.kubernetes?.context, "prod");
  assert.deepEqual(
    result.reads.map(({ path }) => path),
    ["/missing", "/oversized", "/valid"],
  );
  const limited = await collect({
    options: { max_config_files: 1 },
    environment: { KUBECONFIG: "/missing:/valid" },
    files: { "/valid": kubeconfig() },
  });
  assert.equal(limited.snapshot.modules.kubernetes, undefined);
  assert.deepEqual(
    limited.reads.map(({ path }) => path),
    ["/missing"],
  );
});

test("Kubernetes applies symbol/style overrides without exposing private selector values", async () => {
  const result = await collect({
    options: {
      format: "[$symbol$context]($style)",
      contexts: [{ context_pattern: "prod", symbol: "K ", style: "bold red" }],
    },
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.modules.kubernetes?.symbol, "K ");
  assert.equal(result.snapshot.styleSelectors?.kubernetes, "bold red");
  assert.equal(Object.hasOwn(result.snapshot.modules.kubernetes ?? {}, PRIVATE_STYLE_SELECTOR), false);
  assert.equal(Object.isFrozen(result.snapshot.modules.kubernetes), true);
  assert.equal(Object.isFrozen(result.snapshot.styleSelectors), true);
  const rendered = renderStatusline(result.config, runtime(result.snapshot));
  assert.equal(stripVTControlCharacters(rendered.ansi), "K prod");
  assert.ok(rendered.chunks.every((chunk) => JSON.stringify(chunk.style) === JSON.stringify(parseStyle("bold red"))));
});

test("Kubernetes explicit empty symbol/style clears configured presentation", async () => {
  const result = await collect({
    options: {
      format: "[$symbol$context]($style)",
      symbol: "global ",
      style: "bold red",
      contexts: [{ context_pattern: "prod", symbol: "", style: "" }],
    },
  });
  assert.deepEqual(result.diagnostics, []);
  const rendered = renderStatusline(result.config, runtime(result.snapshot));
  assert.equal(rendered.ansi, "prod");
  assert.equal(result.snapshot.styleSelectors?.kubernetes, "");
});

test("Kubernetes first rule blocks later style and symbol overrides even without its own overrides", async () => {
  const result = await collect({
    options: { contexts: [{ context_pattern: "prod" }, { context_pattern: "prod", style: "red", symbol: "wrong " }] },
  });
  assert.equal(result.snapshot.styleSelectors, undefined);
  assert.equal(result.snapshot.modules.kubernetes?.symbol, undefined);
  assert.equal(
    stripVTControlCharacters(renderStatusline(result.config, runtime(result.snapshot)).ansi),
    "on ☸ prod (default) ",
  );
});

test("Kubernetes rendering, inspection, and repeated preview stay pure and sanitize rule symbols", async () => {
  const attack = "\u001b]52;c;secret\u0007";
  const result = await collect({
    options: {
      format: "$symbol$context/$user",
      contexts: [
        { context_pattern: "prod", symbol: `K${attack} `, context_alias: "production", user_alias: "operator" },
      ],
    },
  });
  const snapshot = runtime(result.snapshot);
  const before = structuredClone(snapshot);
  const beforeConfig = structuredClone(result.config);
  const readCount = result.reads.length;
  for (let pass = 0; pass < 2; pass += 1) {
    const rendered = renderStatusline(result.config, snapshot);
    assert.equal(rendered.ansi, "K production/operator");
    const inspected = inspectStatuslineModules(result.config, snapshot).modules.find(
      ({ name }) => name === "kubernetes",
    );
    assert.equal(inspected?.preview, "K production/operator");
  }
  assert.equal(result.reads.length, readCount);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(result.config, beforeConfig);
});

test("Kubernetes kubeconfig remains inert with credential helpers, token paths, and cluster URLs", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const result = await collect({
      files: {
        [DEFAULT_CONFIG]: kubeconfig(
          {},
          {
            users: [
              {
                name: "alice",
                user: {
                  exec: {
                    command: "credential-helper",
                    args: ["--never-run"],
                    env: [{ name: "SECRET", value: "hidden" }],
                  },
                  "auth-provider": { name: "gcp", config: { "cmd-path": "another-helper" } },
                  tokenFile: "/never-read-token",
                  "client-key": "/never-read-key",
                  "client-certificate": "/never-read-certificate",
                },
              },
            ],
            clusters: [
              {
                name: "cluster",
                cluster: { server: "https://never-contact.invalid", "certificate-authority": "/never-read-ca" },
              },
            ],
          },
        ),
      },
    });
    assert.equal(result.snapshot.modules.kubernetes?.user, "alice");
    assert.deepEqual(
      result.reads.map(({ path }) => path),
      [DEFAULT_CONFIG],
    );
    assert.deepEqual(result.commands, []);
    assert.equal(fetch.mock.calls.length, 0);
    assert.ok(!JSON.stringify(result.snapshot).includes("hidden"));
  } finally {
    fetch.mockRestore();
  }
});

test("Kubernetes cancellation after a pending read discards its result and prevents further reads", async () => {
  const controller = new AbortController();
  let ready: (() => void) | undefined;
  let finish: ((source: string) => void) | undefined;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const reads: string[] = [];
  const collection = collect({
    environment: { KUBECONFIG: "/first:/second" },
    signal: controller.signal,
    readFile: async (path) => {
      reads.push(path);
      ready?.();
      return pending;
    },
  });
  await readiness;
  controller.abort();
  finish?.(kubeconfig());
  const result = await collection;
  assert.deepEqual(result.snapshot.modules, {});
  assert.deepEqual(reads, ["/first"]);
});

test("Kubernetes does no work for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await collect({ signal: controller.signal, options: { detect_files: ["kube.yaml"] } });
  assert.deepEqual(result.snapshot.modules, {});
  assert.deepEqual(result.scans, []);
  assert.deepEqual(result.reads, []);
});

test("Kubernetes cancellation after directory detection prevents kubeconfig reads", async () => {
  const controller = new AbortController();
  const result = await collect({
    options: { detect_files: ["kube.yaml"] },
    signal: controller.signal,
    readDirectory: async () => {
      controller.abort();
      return [file("kube.yaml")];
    },
  });
  assert.deepEqual(result.snapshot.modules, {});
  assert.deepEqual(result.reads, []);
});

test("Kubernetes nested rules and detection survive effective TOML projection without changing source", () => {
  const source = [
    'format = "$kubernetes"',
    "[kubernetes]",
    'detect_env_vars = ["KUBE_MODE", "!KUBE_HIDE"]',
    'detect_files = ["kube.yaml", "!skip"]',
    "# Keep comments and unknown fields in the source document.",
    'future_field = "retained"',
    "[[kubernetes.contexts]]",
    'context_pattern = "prod.*"',
    'user_pattern = "alice"',
    'style = "bold red"',
    'symbol = "K "',
    'context_alias = "production"',
    'user_alias = "operator"',
  ].join("\n");
  const loaded = validateConfigDocument("/settings.toml", source);
  assert.equal(loaded.rawDocument, source);
  assert.equal(loaded.diagnostics.filter(({ path }) => !path.includes("future_field")).length, 0);
  const restored = validateConfigDocument("/effective.toml", serializeEffectiveConfig(loaded.config));
  assert.deepEqual(restored.config.modules.kubernetes.options, loaded.config.modules.kubernetes.options);
  assert.equal(loaded.rawDocument, source);
});

test.each([
  { name: "not an array", contexts: {} },
  { name: "non-table entry", contexts: ["prod"] },
  { name: "missing context pattern", contexts: [{ user_pattern: "alice" }] },
  { name: "non-string pattern", contexts: [{ context_pattern: 42 }] },
  { name: "non-string alias", contexts: [{ context_pattern: "prod", context_alias: 42 }] },
  { name: "non-string symbol", contexts: [{ context_pattern: "prod", symbol: true }] },
  { name: "invalid style", contexts: [{ context_pattern: "prod", style: "not-a-style" }] },
  { name: "malformed regex", contexts: [{ context_pattern: "prod[" }] },
  { name: "malformed user regex", contexts: [{ context_pattern: "prod", user_pattern: "alice[" }] },
  { name: "unknown rule field", contexts: [{ context_pattern: "prod", future_field: "ignored" }] },
  { name: "alias length limit", contexts: [{ context_pattern: "prod", context_alias: "p".repeat(4_097) }] },
  { name: "unsupported lookahead", contexts: [{ context_pattern: "prod(?=x)" }] },
  { name: "unsupported backreference", contexts: [{ context_pattern: "(prod)\\1" }] },
  { name: "pattern length limit", contexts: [{ context_pattern: "p".repeat(513) }] },
  {
    name: "user pattern length limit",
    contexts: [{ context_pattern: "prod", user_pattern: `^(?:${"a".repeat(507)})$` }],
  },
  { name: "rule count limit", contexts: Array.from({ length: 65 }, () => ({ context_pattern: "prod" })) },
])("Kubernetes rejects malformed rules safely: $name", async ({ contexts }) => {
  const result = await collect({ options: { contexts } });
  assert.ok(result.diagnostics.some(({ path }) => path.startsWith("kubernetes.contexts")));
  assert.deepEqual(result.config.modules.kubernetes.options.contexts, []);
  assert.equal(result.snapshot.modules.kubernetes?.context, "prod");
});

test("Kubernetes accepts nested ambiguous repetition through bounded RE2 matching", async () => {
  const name = `${"a".repeat(150)}!`;
  const result = await collect({
    options: {
      contexts: [
        { context_pattern: "(a+)+", context_alias: "wrong" },
        { context_pattern: ".*", context_alias: "fallback" },
      ],
    },
    files: { [DEFAULT_CONFIG]: kubeconfig({}, { "current-context": name }) },
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.modules.kubernetes?.context, "fallback");
});
