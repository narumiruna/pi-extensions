import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { test } from "vitest";
import {
  atomicSaveConfigDocument,
  BUILT_IN_CONFIG,
  BUILT_IN_EXAMPLE,
  CONFIG_FILE_NAME,
  loadStarshipConfig,
  MODULE_NAMES,
  normalizeConfig,
  settingsFilePath,
  validateConfigDocument,
} from "../src/config.js";
import { projectEffectiveConfig, serializeEffectiveConfig } from "../src/effective-config.js";
import { MODULE_DEFINITIONS } from "../src/modules/catalog.js";
import { reachableModuleRequirements } from "../src/modules/index.js";
import { presetForDocument, STARSHIP_PRESETS } from "../src/presets/catalog.js";

test("bundled presets are distinct, valid, and limited to local core modules", () => {
  assert.deepEqual(
    STARSHIP_PRESETS.map((preset) => preset.id),
    [
      "minimal",
      "bracketed-segments",
      "catppuccin-powerline",
      "gruvbox-rainbow",
      "jetpack",
      "nerd-font-symbols",
      "no-empty-icons",
      "no-nerd-font",
      "no-runtime-versions",
      "pastel-powerline",
      "plain-text-symbols",
      "pure-preset",
      "tokyo-night",
    ],
  );
  assert.equal(new Set(STARSHIP_PRESETS.map((preset) => preset.id)).size, STARSHIP_PRESETS.length);
  assert.deepEqual(
    STARSHIP_PRESETS.filter((preset) => preset.requiresNerdFont).map((preset) => preset.id),
    ["catppuccin-powerline", "gruvbox-rainbow", "nerd-font-symbols", "pastel-powerline", "tokyo-night"],
  );

  const allowedModules = new Set([
    "brand",
    "model",
    "thinking",
    "directory",
    "git_branch",
    "git_state",
    "git_status",
    "activity",
    "context",
    "time",
    "fill",
  ]);
  for (const preset of STARSHIP_PRESETS) {
    const loaded = validateConfigDocument(`/presets/${preset.id}.toml`, preset.rawDocument);
    assert.deepEqual(loaded.diagnostics, [], preset.id);
    assert.ok(preset.label.length > 0, preset.id);
    assert.ok(preset.description.length > 0, preset.id);
    for (const name of reachableModuleRequirements(loaded.config).keys()) {
      assert.equal(allowedModules.has(name), true, `${preset.id}: ${name}`);
    }
    assert.equal(presetForDocument(preset.rawDocument)?.id, preset.id);
    assert.equal(presetForDocument(`${preset.rawDocument}\n`), undefined);
  }
  assert.equal(presetForDocument(undefined), undefined);
});

test("effective configuration projects every public catalog field in stable order", () => {
  const projected = projectEffectiveConfig(BUILT_IN_CONFIG);
  assert.deepEqual(Object.keys(projected), ["format", "palettes", ...MODULE_NAMES]);
  for (const definition of MODULE_DEFINITIONS) {
    const table = projected[definition.name];
    assert.equal(typeof table, "object", definition.name);
    assert.equal(Array.isArray(table), false, definition.name);
    assert.equal(Object.hasOwn(table as object, "formatAst"), false, definition.name);
    assert.equal(Object.hasOwn(table as object, "format"), true, definition.name);
    assert.equal(Object.hasOwn(table as object, "symbol"), true, definition.name);
    assert.equal(Object.hasOwn(table as object, "disabled"), true, definition.name);
    for (const option of Object.keys(definition.options ?? {})) {
      assert.equal(Object.hasOwn(table as object, option), true, `${definition.name}.${option}`);
    }
  }
  const serialized = serializeEffectiveConfig(BUILT_IN_CONFIG);
  assert.equal(serialized, serializeEffectiveConfig(BUILT_IN_CONFIG));
  assert.doesNotMatch(serialized, /formatAst|styleSelectors|maxStatuses/u);
  assert.ok(serialized.indexOf("[brand]") < serialized.indexOf("[provider]"));
  assert.ok(serialized.indexOf("[provider]") < serialized.indexOf("[model]"));
  assert.deepEqual(normalizeConfig(parse(serialized)).config, BUILT_IN_CONFIG);
});

test("effective configuration normalizes custom public values without document-only data", () => {
  const loaded = validateConfigDocument(
    "/effective/pi-starship.toml",
    `format = '$model$git_metrics$context$extension_status'\npalette = 'demo'\nfuture = 'document only'\n\n[palettes.demo]\nz = '#654321'\naccent = '#123456'\n\n[model]\nformat = '[$symbol$model]($style)'\nsymbol = 'M '\nstyle = 'bold accent'\ndisabled = false\ntruncation_length = 12\nmodel_aliases = { z = 'last', a = 'first' }\n\n[git_metrics]\nadded_style = 'green'\ndeleted_style = 'red'\ndisabled = false\n\n[[context.display]]\nthreshold = 0\nstyle = 'accent'\nhidden = false\n\n[extension_status]\nseparator = ' / '\nmax_statuses = 3\nicons = { demo = 'D' }\n`,
  );
  const serialized = serializeEffectiveConfig(loaded.config);
  const reparsed = normalizeConfig(parse(serialized));
  assert.deepEqual(reparsed.diagnostics, []);
  assert.deepEqual(reparsed.config, loaded.config);
  assert.doesNotMatch(serialized, /future|document only/u);
  assert.match(serialized, /palette = "demo"/u);
  assert.match(serialized, /max_statuses = 3/u);
  assert.match(serialized, /truncation_length = 12/u);
  assert.ok(serialized.indexOf('accent = "#123456"') < serialized.indexOf('z = "#654321"'));
  assert.ok(serialized.indexOf('a = "first"') < serialized.indexOf('z = "last"'));
});

test("config path uses the agent directory and missing settings use built-in defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  try {
    const path = settingsFilePath(root);
    assert.equal(path, join(root, CONFIG_FILE_NAME));
    const loaded = loadStarshipConfig(path);
    assert.equal(loaded.source, "built-in");
    assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable Starship settings report an I/O diagnostic instead of appearing missing", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-unreadable-"));
  const path = join(root, "inaccessible", CONFIG_FILE_NAME);
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = ((filePath: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    if (String(filePath) === path) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return (originalReadFileSync as (...values: unknown[]) => unknown)(filePath, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const loaded = loadStarshipConfig(path);
    assert.equal(loaded.source, "built-in");
    assert.match(loaded.diagnostics[0]?.message ?? "", /Unable to read settings.*permission denied/i);
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("built-in example is a palette-free nine-module Starship document", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    assert.match(BUILT_IN_EXAMPLE, /^format = """/mu);
    assert.match(BUILT_IN_EXAMPLE, /\$brand\\\n\$model\\\n\$thinking\\\n\$directory/u);
    assert.doesNotMatch(BUILT_IN_EXAMPLE, /format = '''|palette\s*=|\[palettes\.|░▒▓|/u);
    writeFileSync(path, BUILT_IN_EXAMPLE);
    const loaded = loadStarshipConfig(path);
    assert.equal(
      loaded.config.format,
      [
        "$brand",
        "$model",
        "$thinking",
        "$directory",
        "$git_branch",
        "$git_status",
        "$activity",
        "$context",
        "$time",
      ].join(""),
    );
    assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
    assert.equal(loaded.config.palette, undefined);
    assert.deepEqual(loaded.config.palettes, {});
    assert.deepEqual(loaded.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git and GitHub PR modules use deterministic display order", () => {
  const gitModules = MODULE_NAMES.filter((name) => name.startsWith("git_"));
  assert.deepEqual(gitModules, ["git_worktree", "git_branch", "git_commit", "git_state", "git_metrics", "git_status"]);
  assert.equal(MODULE_NAMES.indexOf("github_pr"), MODULE_NAMES.indexOf("git_branch") + 1);
  assert.match(BUILT_IN_CONFIG.format, /\$git_branch\$git_status/u);
  assert.doesNotMatch(BUILT_IN_CONFIG.format, /\$github_pr/u);
});

test("removed git_branch $pr settings use the generic unknown-variable diagnostic", () => {
  const normalized = normalizeConfig({
    format: "$git_branch",
    git_branch: { format: "$branch$pr" },
  });
  assert.equal(BUILT_IN_CONFIG.modules.git_branch.format.includes("$pr"), false);
  assert.match(
    normalized.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"),
    /git_branch\.format.*unknown variable.*pr/iu,
  );
});

test("first-wave modules are registered in deterministic domain order", () => {
  for (const name of [
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
    "fill",
  ] as const) {
    assert.ok(MODULE_NAMES.includes(name), name);
  }
  assert.ok(MODULE_NAMES.indexOf("package") < MODULE_NAMES.indexOf("nodejs"));
  assert.ok(MODULE_NAMES.indexOf("openstack") < MODULE_NAMES.indexOf("os"));
  assert.ok(MODULE_NAMES.indexOf("tokens") < MODULE_NAMES.indexOf("cache"));
  assert.ok(MODULE_NAMES.indexOf("cache") < MODULE_NAMES.indexOf("cost"));
  assert.equal(BUILT_IN_CONFIG.modules.cache.disabled, true);
  assert.ok(MODULE_NAMES.indexOf("fill") < MODULE_NAMES.indexOf("extension_status"));
});

test("catalog-owned module options normalize values and diagnose invalid input", () => {
  const valid = loadFromText(
    `format = '$package$hostname'\n\n[package]\nversion_format = 'v$raw'\n\n[nodejs]\ndetect_files = ['package.json']\ndetect_extensions = ['js', 'ts']\n\n[hostname]\nssh_only = false\ntrim_at = '.'\naliases = { workstation = 'dev' }\n`,
  );
  assert.equal(valid.config.modules.package.options.version_format, "v$raw");
  assert.deepEqual(valid.config.modules.nodejs.options.detect_files, ["package.json"]);
  assert.equal(valid.config.modules.hostname.options.ssh_only, false);
  assert.deepEqual(valid.config.modules.hostname.options.aliases, { workstation: "dev" });
  assert.deepEqual(valid.diagnostics, []);

  const invalid = loadFromText(
    `format = '$package'\n\n[package]\nversion_format = 7\nfuture = true\n\n[nodejs]\ndetect_files = ['ok', 3]\n\n[cache]\nfuture = true\n`,
  );
  const invalidMessages = invalid.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n");
  assert.match(invalidMessages, /package\.version_format.*string|package\.future|nodejs\.detect_files/iu);
  assert.match(invalidMessages, /cache\.future/iu);
});

test("Starship-aligned module options normalize their public defaults", () => {
  assert.deepEqual(BUILT_IN_CONFIG.modules.directory.options, {
    truncation_length: 3,
    truncate_to_repo: true,
    fish_style_pwd_dir_length: 0,
    truncation_symbol: "",
    home_symbol: "~",
    use_os_path_sep: true,
    substitutions: {},
  });
  assert.deepEqual(BUILT_IN_CONFIG.modules.git_branch.options, {
    truncation_length: 0,
    truncation_symbol: "…",
  });
  assert.deepEqual(BUILT_IN_CONFIG.modules.git_commit.options, { commit_hash_length: 7 });
  assert.deepEqual(BUILT_IN_CONFIG.modules.conda.options, {
    ignore_base: true,
    truncation_length: 1,
  });

  const valid = loadFromText(
    "[directory]\ntruncation_length = 2\ntruncate_to_repo = false\nfish_style_pwd_dir_length = 1\ntruncation_symbol = '…/'\nhome_symbol = '⌂'\nuse_os_path_sep = false\nsubstitutions = { workspace = 'w' }\n\n[git_branch]\ntruncation_length = 24\ntruncation_symbol = ''\n\n[git_commit]\ncommit_hash_length = 10\n\n[conda]\ntruncation_length = 0\n\n[hostname]\ntrim_at = ''\n",
  );
  assert.deepEqual(valid.diagnostics, []);
  assert.equal(valid.config.modules.directory.options.truncation_length, 2);
  assert.deepEqual(valid.config.modules.directory.options.substitutions, { workspace: "w" });
  assert.equal(valid.config.modules.git_branch.options.truncation_length, 24);
  assert.equal(valid.config.modules.git_commit.options.commit_hash_length, 10);
  assert.deepEqual(loadFromText("[git_commit]\ncommit_hash_length = 0\n").diagnostics, []);
  assert.equal(valid.config.modules.conda.options.truncation_length, 0);
  assert.equal(valid.config.modules.hostname.options.trim_at, "");
});

test("model truncation options normalize values and reject invalid directions independently", () => {
  assert.deepEqual(BUILT_IN_CONFIG.modules.model.options, {
    truncation_length: 0,
    truncation_symbol: "…",
    truncation_direction: "end",
    model_aliases: {},
  });

  const valid = loadFromText(
    "[model]\ntruncation_length = 36\ntruncation_symbol = ''\ntruncation_direction = 'middle'\nmodel_aliases = { raw = 'short' }\n",
  );
  assert.deepEqual(valid.config.modules.model.options, {
    truncation_length: 36,
    truncation_symbol: "",
    truncation_direction: "middle",
    model_aliases: { raw: "short" },
  });
  assert.deepEqual(valid.diagnostics, []);

  const invalid = loadFromText(
    "[model]\ntruncation_length = -1\ntruncation_symbol = 7\ntruncation_direction = 'left'\n",
  );
  assert.deepEqual(invalid.config.modules.model.options, {
    truncation_length: 0,
    truncation_symbol: "…",
    truncation_direction: "end",
    model_aliases: {},
  });
  assert.deepEqual(
    invalid.diagnostics.map((item) => item.path),
    ["model.truncation_length", "model.truncation_symbol", "model.truncation_direction"],
  );

  const oversized = loadFromText("[model]\ntruncation_length = 1001\n");
  assert.equal(oversized.config.modules.model.options.truncation_length, 0);
  assert.equal(oversized.diagnostics[0]?.path, "model.truncation_length");
});

test("thinking level styles preserve and validate the legacy fallback independently", () => {
  assert.deepEqual(BUILT_IN_CONFIG.modules.thinking.styles, {
    style_off: "",
    style_minimal: "",
    style_low: "",
    style_medium: "",
    style_high: "",
    style_xhigh: "",
    style_max: "",
  });

  const valid = normalizeConfig({
    thinking: {
      style: "fg:#010203 bg:#040506 bold",
      style_high: "italic red",
    },
  });
  assert.equal(valid.config.modules.thinking.style, "fg:#010203 bg:#040506 bold");
  assert.equal(valid.config.modules.thinking.styles.style_high, "italic red");
  assert.deepEqual(valid.diagnostics, []);

  const invalid = normalizeConfig({
    thinking: { style: "not-a-color", style_low: "also-not-a-color", style_high: 7 },
    username: { style: "blue" },
  });
  assert.equal(invalid.config.modules.thinking.style, BUILT_IN_CONFIG.modules.thinking.style);
  assert.equal(invalid.config.modules.thinking.styles.style_low, "");
  assert.equal(invalid.config.modules.thinking.styles.style_high, "");
  assert.deepEqual(
    invalid.diagnostics.map((item) => item.path),
    ["thinking.style_high", "username.style", "thinking.style", "thinking.style_low"],
  );
});

test("provider aliases normalize as exact string mappings", () => {
  assert.deepEqual(BUILT_IN_CONFIG.modules.provider.options, { provider_aliases: {} });
  const normalized = normalizeConfig({
    provider: { provider_aliases: { "openai-codex": "codex", anthropic: "claude" } },
  });
  assert.deepEqual(normalized.config.modules.provider.options.provider_aliases, {
    "openai-codex": "codex",
    anthropic: "claude",
  });
  assert.deepEqual(normalized.diagnostics, []);
});

test("valid TOML loads root, palette, module, and extension status settings", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(
      path,
      `format = '$model$cache$cost$extension_status'\npalette = 'mine'\n\n[palettes.mine]\nblue = '#010203'\n\n[model]\nformat = '[$model]($style)'\nsymbol = 'M'\nstyle = 'bold blue'\ndisabled = true\n\n[cache]\nformat = '$read/$write/$rate'\ndisabled = false\n\n[cost]\nformat = '$cost$subscription'\n\n[extension_status]\nseparator = ' | '\nmax_statuses = 3\n\n[extension_status.icons]\ngoal = ''\n`,
    );
    const loaded = loadStarshipConfig(path);
    assert.equal(loaded.source, "user");
    assert.equal(loaded.config.format, "$model$cache$cost$extension_status");
    assert.equal(loaded.config.palette, "mine");
    assert.deepEqual(loaded.config.palettes.mine, { blue: "#010203" });
    assert.equal(loaded.config.modules.model.format, "[$model]($style)");
    assert.equal(loaded.config.modules.model.symbol, "M");
    assert.equal(loaded.config.modules.model.style, "bold blue");
    assert.equal(loaded.config.modules.model.disabled, true);
    assert.equal(loaded.config.modules.cache.format, "$read/$write/$rate");
    assert.equal(loaded.config.modules.cache.disabled, false);
    assert.equal(loaded.config.modules.cost.format, "$cost$subscription");
    assert.equal(loaded.config.extensionStatus.separator, " | ");
    assert.equal(loaded.config.extensionStatus.maxStatuses, 3);
    assert.deepEqual(loaded.config.extensionStatus.icons, { goal: "" });
    assert.deepEqual(loaded.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed TOML reports an error and uses the full built-in config", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(path, "format = [");
    const loaded = loadStarshipConfig(path);
    assert.equal(loaded.source, "built-in");
    assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
    assert.equal(loaded.diagnostics[0]?.severity, "error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid recognized fields fall back independently and unknown fields warn", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(
      path,
      `format = 7\npalette = 'missing'\nfuture = true\n\n[model]\nstyle = 1\ndisabled = 'no'\nfuture = 'keep'\n\n[palettes.bad]\noops = 'not-a-color'\n`,
    );
    const loaded = loadStarshipConfig(path);
    assert.equal(loaded.source, "user");
    assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
    assert.equal(loaded.config.palette, "missing");
    assert.equal(loaded.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
    assert.equal(loaded.config.modules.model.disabled, false);
    assert.ok(loaded.diagnostics.length >= 6);
    assert.ok(loaded.diagnostics.every((item) => item.severity === "warning"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("palette normalization handles prototype-like names as exact own properties", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(path, "palette = 'toString'\n\n[model]\nstyle = 'toString'\n");
    const inherited = loadStarshipConfig(path);
    assert.equal(inherited.config.palette, "toString");
    assert.equal(inherited.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
    assert.match(inherited.diagnostics.map((item) => item.message).join("\n"), /unknown palette.*toString/i);

    writeFileSync(path, "palette = '__proto__'\n\n[palettes.__proto__]\naccent = 'red'\n\n[model]\nstyle = 'accent'\n");
    const exact = loadStarshipConfig(path);
    assert.equal(exact.config.palette, "__proto__");
    assert.equal(Object.hasOwn(exact.config.palettes, "__proto__"), true);
    assert.deepEqual(Reflect.get(exact.config.palettes, "__proto__"), { accent: "red" });
    assert.equal(exact.config.modules.model.style, "accent");
    assert.deepEqual(exact.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only an explicitly selected custom palette is active", () => {
  const unselected = normalizeConfig({
    palettes: { mine: { blue: "#010203", accent: "17" } },
    model: { style: "accent" },
  });
  assert.equal(unselected.config.palette, undefined);
  assert.equal(unselected.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
  assert.match(unselected.diagnostics.map((item) => item.message).join("\n"), /invalid style/iu);

  const selected = normalizeConfig({
    palette: "mine",
    palettes: { mine: { blue: "#010203", accent: "17" } },
    model: { style: "accent" },
  });
  assert.equal(selected.config.palette, "mine");
  assert.equal(selected.config.modules.model.style, "accent");
  assert.deepEqual(selected.diagnostics, []);
});

test("legacy palette aliases warn and receive no hidden fallback colors", () => {
  const normalized = normalizeConfig({
    format: "[root](header)$directory",
    directory: { style: "fg:directory_fg bg:directory" },
  });
  assert.equal(normalized.config.palette, undefined);
  assert.equal(normalized.config.modules.directory.style, BUILT_IN_CONFIG.modules.directory.style);
  const messages = normalized.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n");
  assert.match(messages, /format.*invalid literal style.*header/iu);
  assert.match(messages, /directory\.style.*invalid style/iu);
});

test("built-in module styles use direct colors without backgrounds", () => {
  const expected = {
    brand: "bold white",
    provider: "bold blue",
    model: "bold blue",
    thinking: "bold purple",
    directory: "cyan bold",
    git_worktree: "cyan bold",
    git_branch: "bold purple",
    github_pr: "bold blue",
    git_commit: "green bold",
    git_state: "bold yellow",
    git_status: "red bold",
    activity: "bold yellow",
    tokens: "bold cyan",
    cache: "bold green",
    time: "bold yellow",
    turn: "bold purple",
    extension_status: "dimmed white",
    direnv: "bold bright-yellow",
    fill: "bold black",
  } as const;
  for (const [name, style] of Object.entries(expected)) {
    assert.equal(BUILT_IN_CONFIG.modules[name as keyof typeof expected].style, style, name);
  }
  for (const module of Object.values(BUILT_IN_CONFIG.modules)) {
    for (const style of [
      module.style,
      ...Object.values(module.styles),
      ...module.display.map((entry) => entry.style),
    ]) {
      assert.doesNotMatch(style, /(?:^|\s)bg:/u);
    }
  }
});

test("invalid direct palette values warn and palette aliases cannot reference aliases", () => {
  const normalized = normalizeConfig({
    palette: "mine",
    palettes: { mine: { direct: "#010203", recursive: "direct" } },
    model: { style: "recursive" },
  });
  assert.deepEqual(normalized.config.palettes.mine, { direct: "#010203" });
  assert.equal(normalized.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
  assert.match(
    normalized.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"),
    /palettes\.mine\.recursive.*named.*ANSI.*#RRGGBB|model\.style.*invalid style/iu,
  );
});

test("multi-style and display settings normalize independently", () => {
  const normalized = normalizeConfig({
    git_metrics: {
      added_style: "not-a-color",
      deleted_style: "blue",
      style: "red",
    },
    username: { style_user: "cyan bold", style_root: "bright-red bold" },
    context: {
      display: [
        { threshold: 0, style: "bold green", hidden: true },
        { threshold: 50, style: "fg:not-a-color", hidden: false },
        { threshold: 80, style: "bold red", hidden: false, future: true },
      ],
    },
    cost: { display: [{ threshold: Number.NaN, style: "yellow", hidden: false }] },
  });
  assert.deepEqual(normalized.config.modules.git_metrics.styles, {
    added_style: "bold green",
    deleted_style: "blue",
  });
  assert.deepEqual(normalized.config.modules.username.styles, {
    style_user: "cyan bold",
    style_root: "bright-red bold",
  });
  assert.deepEqual(normalized.config.modules.context.display, [
    { threshold: 0, style: "bold green", hidden: true },
    { threshold: 80, style: "bold red", hidden: false },
  ]);
  assert.deepEqual(normalized.config.modules.cost.display, BUILT_IN_CONFIG.modules.cost.display);
  const messages = normalized.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n");
  assert.match(messages, /git_metrics\.style.*unknown setting/iu);
  assert.match(messages, /git_metrics\.added_style.*invalid style/iu);
  assert.match(messages, /context\.display\.1\.style/iu);
  assert.match(messages, /context\.display\.2\.future/iu);
  assert.match(messages, /cost\.display\.0\.threshold/iu);
});

test("display arrays use module defaults when no valid entries remain", () => {
  const normalized = normalizeConfig({
    context: { display: [] },
    cost: { display: "wrong" },
  });
  assert.deepEqual(normalized.config.modules.context.display, BUILT_IN_CONFIG.modules.context.display);
  assert.deepEqual(normalized.config.modules.cost.display, BUILT_IN_CONFIG.modules.cost.display);
  assert.deepEqual(
    normalized.diagnostics.map((item) => item.path),
    ["context.display", "cost.display"],
  );
});

test("unknown root/module/style variables warn and invalid styles fall back", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(
      path,
      `format = '$model$unknown[ok]($mystyle)'\n\n[model]\nformat = '$symbol$bad[ok]($other)'\nstyle = 'not-a-color'\n`,
    );
    const loaded = loadStarshipConfig(path);
    const messages = loaded.diagnostics.map((item) => item.message).join("\n");
    assert.match(messages, /unknown.*variable/i);
    assert.match(messages, /style variable.*mystyle/i);
    assert.match(messages, /variable.*bad.*model/i);
    assert.match(messages, /style variable.*other/i);
    assert.match(messages, /style.*not-a-color/i);
    assert.equal(loaded.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid root and module formats fall back at the documented scope", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(path, `format = '['\n\n[model]\nformat = '$ '\nsymbol = 'custom'\n`);
    const loaded = loadStarshipConfig(path);
    assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
    assert.equal(loaded.config.modules.model.format, BUILT_IN_CONFIG.modules.model.format);
    assert.equal(loaded.config.modules.model.symbol, "custom");
    assert.equal(loaded.diagnostics.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("draft validation never writes and retains unknown TOML fields", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(path, "format = '$model'\nfuture = 'old'\n");
    const draft = "format = '$provider'\nfuture = 'preserved'\n";
    const validated = validateConfigDocument(path, draft);
    assert.equal(validated.config.format, "$provider");
    assert.equal(validated.rawDocument, draft);
    assert.equal(readFileSync(path, "utf8"), "format = '$model'\nfuture = 'old'\n");
    assert.match(validated.diagnostics.map((item) => item.message).join(" "), /future/u);
    assert.throws(() => validateConfigDocument(path, "format = ["), /parse TOML/iu);
    assert.equal(readFileSync(path, "utf8"), "format = '$model'\nfuture = 'old'\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic saves preserve the raw document and replace the old file", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(path, "format = '$model'\nfuture = 'old'\n");
    const raw = "format = '$provider'\nfuture = 'preserved'\n";
    const loaded = atomicSaveConfigDocument(path, raw);
    assert.equal(readFileSync(path, "utf8"), raw);
    assert.equal(loaded.config.format, "$provider");
    assert.match(loaded.diagnostics.map((item) => item.message).join(" "), /future/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic publish failure keeps the previous file and removes temp files", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(path, "format = '$model'\n");
    assert.throws(() =>
      atomicSaveConfigDocument(path, "format = '$provider'\n", {
        renameSync() {
          throw new Error("publish failed");
        },
      }),
    );
    assert.equal(readFileSync(path, "utf8"), "format = '$model'\n");
    assert.equal(existsSync(root) && readFileSync(path, "utf8").includes("provider"), false);
    assert.deepEqual(
      requireDirectory(root).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first Starship saves preserve settings created before publication", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-first-save-race-"));
  const path = settingsFilePath(root);
  const concurrent = "format = 'concurrent'\n";
  try {
    assert.throws(
      () =>
        atomicSaveConfigDocument(path, "format = 'requested'\n", {
          writeFileSync(temporaryPath, data, options) {
            writeFileSync(temporaryPath, data, options);
            writeFileSync(path, concurrent);
          },
        }),
      /created concurrently.*retry/i,
    );
    assert.equal(readFileSync(path, "utf8"), concurrent);
    assert.deepEqual(readdirSync(root), [CONFIG_FILE_NAME]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy pi-statusline files and preset environment never affect config", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
  const previous = process.env.PI_STATUSLINE_PRESET;
  try {
    process.env.PI_STATUSLINE_PRESET = "classic";
    writeFileSync(join(root, "pi-statusline.json"), JSON.stringify({ format: "$model" }));
    const loaded = loadStarshipConfig(join(root, CONFIG_FILE_NAME));
    assert.equal(loaded.source, "built-in");
    assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
  } finally {
    if (previous === undefined) delete process.env.PI_STATUSLINE_PRESET;
    else process.env.PI_STATUSLINE_PRESET = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

function loadFromText(raw: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-config-text-"));
  const path = join(root, CONFIG_FILE_NAME);
  try {
    writeFileSync(path, raw);
    return loadStarshipConfig(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function requireDirectory(path: string): string[] {
  return readdirSync(path);
}
