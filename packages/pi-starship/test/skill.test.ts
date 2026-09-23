import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultResourceLoader, loadSkillsFromDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { BUILT_IN_CONFIG, validateConfigDocument } from "../src/config.js";
import { MODULE_DEFINITIONS, MODULE_NAMES } from "../src/modules/catalog.js";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDirectory = path.join(packageDirectory, "skills");
const skillDirectory = path.join(skillsDirectory, "configuring-pi-starship");
const referencesDirectory = path.join(skillDirectory, "references");
const scriptsDirectory = path.join(skillDirectory, "scripts");
const applyPath = path.join(scriptsDirectory, "apply.mjs");
const backupScriptUrl = pathToFileURL(path.join(scriptsDirectory, "backup.mjs")).href;
const scriptSupportUrl = pathToFileURL(path.join(scriptsDirectory, "script-support.mjs")).href;
const configPathResolver = path.join(scriptsDirectory, "config-path.mjs");
const validatorPath = path.join(scriptsDirectory, "validate.mjs");

test("package bundles one focused pi-starship configuration skill", async () => {
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
    files: string[];
    pi: { extensions: string[]; skills?: string[] };
  };
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.files.includes("skills"));

  const result = loadSkillsFromDir({ dir: skillsDirectory, source: "pi-starship-test" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  const skill = result.skills[0];
  assert.equal(skill?.name, "configuring-pi-starship");
  assert.equal(skill?.disableModelInvocation, true);
  assert.match(skill?.description ?? "", /Configure .* answer questions .*pi-starship\.toml/u);
  for (const excludedTask of [
    "generic TOML",
    "shell Starship configuration",
    "pi-starship source-code development",
    "unrelated footer work",
  ]) {
    assert.ok(skill?.description.includes(excludedTask), `missing trigger exclusion: ${excludedTask}`);
  }

  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-starship-package-skill-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [packageDirectory] }),
      noExtensions: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getSkills();
    assert.deepEqual(loaded.diagnostics, []);
    assert.ok(loaded.skills.some(({ name }) => name === "configuring-pi-starship"));
  } finally {
    rmSync(agentDir, { force: true, recursive: true });
  }
});

test("skill answers from references or source and edits configuration safely", () => {
  const skill = readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
  for (const contract of [
    "For a configuration question, load only the smallest relevant reference",
    "Do not read or modify the user's settings file for a question",
    "../../src/config.ts",
    "../../src/modules/catalog.ts",
    "../../src/presets/",
    "[configuration and format](references/configuration.md)",
    "[the complete module catalog](references/module-catalog.md)",
    "[module behavior](references/modules.md)",
    "[runtime and security](references/runtime-and-security.md)",
    "resolve the active path through Pi's `getAgentDir()` API",
    "Read the existing document before editing it.",
    "Preserve comments, ordering, unknown fields, and unrelated custom settings",
    "make it reachable from the root `format` or `$all`",
    "Do not enable network, command-backed, cloud, deployment, host, or user metadata",
    "Create a separate draft without changing the active document",
    "keep an untouched baseline file containing the exact bytes initially inspected",
    "saves the baseline permanently",
    "pi-starship-202609130742.toml",
    "this check does not lock out another process before rename",
    "retained backups are never deliberately removed",
    "use the explicit `--expect-missing` state",
    "stages the proposed bytes in the destination directory",
    "immediately re-reads the active path",
    "rejects publication when the active bytes differ",
    "writes and flushes the backup to a private temporary file",
    "atomically renames the completed backup into place",
    "flushes the backup directory and its parent directory",
    "reports the primary failure and every cleanup failure",
    "reports the retained backup path",
    "removes its owned temporary backup after a recoverable write or publication failure",
    "keep the durable timestamped backup",
    "do not claim cross-process synchronization",
    "When the pi-starship extension and `/starship status` command are available",
    "When the extension or command is unavailable",
    "Do not claim semantic validation or an active-footer update",
  ]) {
    assert.ok(skill.includes(contract), `missing editing contract: ${contract}`);
  }

  const applyScript = readFileSync(applyPath, "utf8");
  assert.match(applyScript, /let backupPath;/u);
  assert.match(applyScript, /Retained backup:/u);
});

test("skill references own the detailed public configuration guidance", () => {
  const expectedCoverage = {
    "configuration.md": [
      "## ⚙️ Settings",
      "### 🎛️ Presets",
      "## Configuration schema and validation",
      "### Diagnostic and fallback behavior",
      "## 🧩 Format grammar",
      "## 🎨 Styles and palettes",
      "### Content-selected styles",
    ],
    "module-catalog.md": ["## Shared module fields", "## Catalog order", "## Module schemas"],
    "modules.md": [
      "## 🧱 Modules",
      "## Reachability and collection rules",
      "## Exact language defaults",
      "## Exact environment and deployment defaults",
      "### Usage semantics",
      "### Directory, Git, and environment contraction",
      "### Model and provider aliases and model truncation",
    ],
    "runtime-and-security.md": [
      "## 🔒 Security and privacy",
      "### 📦 Package and language modules",
      "### 🚢 Deployment and cloud context",
      "## 📐 Layout and lifecycle",
      "## 🚧 Limitations",
    ],
  } as const;

  for (const [file, headings] of Object.entries(expectedCoverage)) {
    const content = readFileSync(path.join(referencesDirectory, file), "utf8");
    assert.match(content, /authoritative public reference/u);
    for (const heading of headings) assert.ok(content.includes(heading), `${file} lacks ${heading}`);
  }

  const readme = readFileSync(path.join(packageDirectory, "README.md"), "utf8");
  assert.match(readme, /configuration skill is manual-only/u);
  assert.match(readme, /Run `\/skill:configuring-pi-starship` before asking Pi/u);
  for (const file of Object.keys(expectedCoverage)) {
    assert.ok(readme.includes(`./skills/configuring-pi-starship/references/${file}`));
  }
  const configuration = readFileSync(path.join(referencesDirectory, "configuration.md"), "utf8");
  assert.match(configuration, /format = "\$provider\$model\$thinking"/u);
  assert.match(configuration, /runtime value is unavailable.*does not match/iu);
  const example = /### 📝 Example[\s\S]*?```toml\n(?<document>[\s\S]*?)\n```/u.exec(configuration)?.groups?.document;
  assert.ok(example);
  assert.deepEqual(validateConfigDocument("/reference/pi-starship.toml", example).diagnostics, []);
  const modules = readFileSync(path.join(referencesDirectory, "modules.md"), "utf8");
  assert.match(modules, /match `style_rules` against raw provider\/model IDs/iu);

  for (const movedHeading of [
    "## 🧩 Format grammar",
    "## 🎨 Styles and palettes",
    "## 🧱 Modules",
    "## 📐 Layout and lifecycle",
  ]) {
    assert.equal(readme.includes(movedHeading), false, `${movedHeading} must live in skill references`);
  }
});

test("complete module catalog covers every public module schema", () => {
  const catalog = readFileSync(path.join(referencesDirectory, "module-catalog.md"), "utf8");
  assert.deepEqual(
    [...catalog.matchAll(/^### `([^`]+)`$/gmu)].map((match) => match[1]),
    MODULE_NAMES,
  );
  assert.ok(catalog.includes(MODULE_NAMES.map((name) => `\`${name}\``).join(" → ")));

  for (const [index, definition] of MODULE_DEFINITIONS.entries()) {
    const heading = `### \`${definition.name}\``;
    const start = catalog.indexOf(heading);
    const nextName = MODULE_DEFINITIONS[index + 1]?.name;
    const end = nextName ? catalog.indexOf(`### \`${nextName}\``, start) : catalog.length;
    const section = catalog.slice(start, end);
    assert.ok(start >= 0 && end > start, `missing schema for ${definition.name}`);
    assert.ok(section.includes(definition.description));
    assert.ok(section.includes(`Format variables: ${definition.variables.map((name) => `\`$${name}\``).join(", ")}`));
    const styleVariables = definition.styleVariables ?? ["style"];
    assert.ok(
      section.includes(`Style variables in \`format\`: ${styleVariables.map((name) => `\`$${name}\``).join(", ")}`),
    );
    assert.ok(section.includes(`Default \`format\`: ${markdownCode(definition.defaults.format)}`));
    assert.ok(section.includes(`Default \`symbol\`: ${markdownCode(definition.defaults.symbol)}`));
    assert.ok(section.includes(`Default \`disabled\`: ${markdownCode(definition.defaults.disabled)}`));
    if (definition.layout) {
      assert.ok(section.includes(`Layout role: ${markdownCode(definition.layout)}`));
    }

    const styleFields = definition.styleDefaults
      ? [
          ...(definition.fallbackStyle ? ([["style", definition.defaults.style]] as const) : []),
          ...Object.entries(definition.styleDefaults),
        ]
      : definition.displayDefaults
        ? []
        : [["style", definition.defaults.style]];
    for (const [name, value] of styleFields) {
      assert.ok(section.includes(`| \`${name}\` | ${markdownCode(value)} |`));
    }
    if (definition.displayDefaults) {
      assert.ok(section.includes(`Default \`display\`: ${markdownCode(definition.displayDefaults)}`));
    }
    const styleRuleSelectors = Object.keys(definition.styleRuleSelectors ?? {});
    if (styleRuleSelectors.length > 0) {
      assert.ok(section.includes("Accepted style-rule selectors (`style_rules` default: `[]`)"));
      for (const selector of styleRuleSelectors) {
        assert.ok(section.includes(`| \`${selector}\` |`), `${definition.name}.${selector} is missing`);
      }
    }

    for (const [name, schema] of Object.entries(definition.options ?? {})) {
      const row = section.split("\n").find((line) => line.startsWith(`| \`${name}\` |`));
      assert.ok(row, `${definition.name}.${name} is missing`);
      assert.ok(row.includes(optionType(schema.kind)));
      assert.ok(row.includes(markdownCode(schema.default)));
      if (schema.kind === "integer") {
        assert.ok(section.includes(`Inclusive range ${schema.minimum} through ${schema.maximum}.`));
      }
      if (schema.kind === "string-enum") {
        for (const value of schema.values) assert.ok(section.includes(`\`${value}\``));
      }
    }
  }

  assert.match(catalog, /model-ID replacements that bypass built-in Claude\/GPT shortening/u);
  assert.match(
    catalog,
    /replacements applied to the home- or repository-contracted display path before component truncation/u,
  );

  const extensionStatus = catalog.slice(catalog.indexOf("### `extension_status`"));
  for (const [field, value] of Object.entries({
    separator: BUILT_IN_CONFIG.extensionStatus.separator,
    max_statuses: BUILT_IN_CONFIG.extensionStatus.maxStatuses,
    icons: BUILT_IN_CONFIG.extensionStatus.icons,
    styles: BUILT_IN_CONFIG.extensionStatus.styles,
  })) {
    const row = extensionStatus.split("\n").find((line) => line.startsWith(`| \`${field}\` |`));
    assert.ok(row, `extension_status.${field} is missing`);
    assert.ok(row.includes(markdownCode(value)));
  }
});

test("config path resolver returns Pi's tilde-aware absolute agent path", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-path-resolver-"));
  try {
    for (const [configuredAgentDir, expected] of [
      [
        `~/pi-starship-skill-${process.pid}`,
        path.join(homedir(), `pi-starship-skill-${process.pid}`, "pi-starship.toml"),
      ],
      [".pi/agent", path.join(directory, ".pi", "agent", "pi-starship.toml")],
    ] as const) {
      const result = spawnSync(process.execPath, [configPathResolver], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: configuredAgentDir },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout), expected);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("bundled validator accepts valid TOML and bounds terminal-safe errors", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-skill-"));
  try {
    const validPath = path.join(directory, "pi-starship.toml");
    writeFileSync(validPath, 'format = "$model$directory"\n[model]\nstyle = "bold blue"\n');
    const valid = spawnSync(process.execPath, [validatorPath, validPath], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Valid TOML/u);

    const invalidPath = path.join(directory, "invalid-pi-starship.toml");
    writeFileSync(invalidPath, `[model\u001b]0;spoof\u0007\u202e${"x".repeat(5000)}\n`);
    const invalid = spawnSync(process.execPath, [validatorPath, invalidPath], {
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Invalid TOML/u);
    assert.ok(invalid.stderr.includes("…"));
    assert.ok(invalid.stderr.length < 1200, `unbounded stderr: ${invalid.stderr.length}`);
    assert.equal(hasUnsafeTerminalControl(invalid.stderr), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("atomic apply validates staged TOML and rejects stale destinations", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-skill-apply-"));
  const settingsDirectory = path.join(directory, "agent");
  const destinationPath = path.join(settingsDirectory, "pi-starship.toml");
  const draftPath = path.join(directory, "draft.toml");
  const baselinePath = path.join(directory, "baseline.toml");
  const original = 'format = "$model"\n';
  const replacement = 'format = "$directory"\n[directory]\nstyle = "bold blue"\n';
  try {
    mkdirSync(settingsDirectory);
    writeFileSync(destinationPath, original, { flag: "wx", flush: true });
    writeFileSync(baselinePath, original);
    writeFileSync(draftPath, replacement);
    const applied = spawnSync(process.execPath, [applyPath, draftPath, destinationPath, baselinePath], {
      encoding: "utf8",
    });
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Backed up the previous TOML/u);
    assert.match(applied.stdout, /Applied valid TOML atomically/u);
    assert.equal(readFileSync(destinationPath, "utf8"), replacement);
    const backupDirectory = path.join(settingsDirectory, "pi-starship");
    const backupFiles = readdirSync(backupDirectory);
    assert.equal(backupFiles.length, 1);
    assert.match(backupFiles[0] ?? "", /^pi-starship-\d{12}\.toml$/u);
    const backupPath = path.join(backupDirectory, backupFiles[0] ?? "");
    assert.equal(readFileSync(backupPath, "utf8"), original);
    if (process.platform !== "win32") {
      assert.equal(statSync(backupDirectory).mode & 0o777, 0o700);
      assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    }
    assert.deepEqual(readdirSync(settingsDirectory).sort(), ["pi-starship", "pi-starship.toml"]);

    writeFileSync(baselinePath, replacement);
    writeFileSync(draftPath, "[model\n");
    const invalid = spawnSync(process.execPath, [applyPath, draftPath, destinationPath, baselinePath], {
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Draft was not applied/u);
    assert.equal(readFileSync(destinationPath, "utf8"), replacement);
    assert.deepEqual(readdirSync(backupDirectory), backupFiles);
    assert.deepEqual(readdirSync(settingsDirectory).sort(), ["pi-starship", "pi-starship.toml"]);

    const concurrent = 'format = "$brand"\n';
    writeFileSync(draftPath, original);
    writeFileSync(destinationPath, concurrent);
    const changed = spawnSync(process.execPath, [applyPath, draftPath, destinationPath, baselinePath], {
      encoding: "utf8",
    });
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /changed after inspection/u);
    assert.equal(readFileSync(destinationPath, "utf8"), concurrent);
    assert.deepEqual(readdirSync(backupDirectory), backupFiles);
    assert.deepEqual(readdirSync(settingsDirectory).sort(), ["pi-starship", "pi-starship.toml"]);

    writeFileSync(baselinePath, concurrent);
    rmSync(destinationPath);
    const removed = spawnSync(process.execPath, [applyPath, draftPath, destinationPath, baselinePath], {
      encoding: "utf8",
    });
    assert.equal(removed.status, 1);
    assert.match(removed.stderr, /removed after inspection/u);
    assert.deepEqual(readdirSync(backupDirectory), backupFiles);
    assert.deepEqual(readdirSync(settingsDirectory), ["pi-starship"]);

    const appearedDirectory = path.join(directory, "appeared-agent");
    const appearedPath = path.join(appearedDirectory, "pi-starship.toml");
    mkdirSync(appearedDirectory);
    writeFileSync(appearedPath, concurrent);
    const appeared = spawnSync(process.execPath, [applyPath, draftPath, appearedPath, "--expect-missing"], {
      encoding: "utf8",
    });
    assert.equal(appeared.status, 1);
    assert.match(appeared.stderr, /changed after inspection/u);
    assert.equal(readFileSync(appearedPath, "utf8"), concurrent);
    assert.deepEqual(readdirSync(appearedDirectory), ["pi-starship.toml"]);

    const newDestination = path.join(directory, "new-agent", "pi-starship.toml");
    const created = spawnSync(process.execPath, [applyPath, draftPath, newDestination, "--expect-missing"], {
      encoding: "utf8",
    });
    assert.equal(created.status, 0, created.stderr);
    assert.doesNotMatch(created.stdout, /Backed up/u);
    assert.equal(readFileSync(newDestination, "utf8"), original);
    assert.deepEqual(readdirSync(path.dirname(newDestination)), ["pi-starship.toml"]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("atomic apply backs up the exact inspected bytes of a malformed document", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-skill-byte-backup-"));
  const settingsDirectory = path.join(directory, "agent");
  const destinationPath = path.join(settingsDirectory, "pi-starship.toml");
  const draftPath = path.join(directory, "draft.toml");
  const baselinePath = path.join(directory, "baseline.toml");
  const original = Buffer.from([0xff, 0xfe, 0x00, 0x0a]);
  try {
    mkdirSync(settingsDirectory);
    writeFileSync(destinationPath, original);
    writeFileSync(baselinePath, original);
    writeFileSync(draftPath, 'format = "$directory"\n');

    const result = spawnSync(process.execPath, [applyPath, draftPath, destinationPath, baselinePath], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const backupDirectory = path.join(settingsDirectory, "pi-starship");
    const backupFiles = readdirSync(backupDirectory);
    assert.equal(backupFiles.length, 1);
    assert.deepEqual(readFileSync(path.join(backupDirectory, backupFiles[0] ?? "")), original);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("backup creation stages partial writes and preserves an existing minute backup", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-skill-partial-backup-"));
  const destinationPath = path.join(directory, "pi-starship.toml");
  const backupPath = path.join(directory, "pi-starship", "pi-starship-202609130742.toml");
  const expected = Buffer.from("complete backup");
  const now = new Date(2026, 8, 13, 7, 42);
  try {
    const { backupExpectedDocument } = await import(backupScriptUrl);
    await assert.rejects(
      backupExpectedDocument(destinationPath, expected, {
        now,
        openFile: async (
          filePath: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode: Parameters<typeof open>[2],
        ) => {
          assert.notEqual(filePath, backupPath);
          assert.match(path.basename(String(filePath)), /^\.pi-starship-.*\.tmp$/u);
          const handle = await open(filePath, flags, mode);
          return {
            writeFile: async () => {
              await handle.writeFile(expected.subarray(0, 4));
              throw new Error("simulated backup write failure");
            },
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
        },
      }),
      /simulated backup write failure/u,
    );
    assert.equal(existsSync(backupPath), false);
    assert.deepEqual(readdirSync(path.dirname(backupPath)), []);

    const synchronizedDirectories: string[] = [];
    assert.equal(
      await backupExpectedDocument(destinationPath, expected, {
        now,
        syncDirectory: async (directoryPath: string) => {
          synchronizedDirectories.push(directoryPath);
          assert.deepEqual(readFileSync(backupPath), expected);
        },
      }),
      backupPath,
    );
    assert.deepEqual(synchronizedDirectories, [path.dirname(backupPath), directory]);
    await assert.rejects(backupExpectedDocument(destinationPath, Buffer.from("newer"), { now }), /already exists/u);
    assert.deepEqual(readFileSync(backupPath), expected);
    assert.deepEqual(readdirSync(path.dirname(backupPath)), [path.basename(backupPath)]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("backup creation reports directory durability and cleanup failures", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-skill-backup-diagnostics-"));
  const destinationPath = path.join(directory, "pi-starship.toml");
  const expected = Buffer.from("complete backup");
  try {
    const { backupExpectedDocument } = await import(backupScriptUrl);
    const retainedPath = path.join(directory, "pi-starship", "pi-starship-202609130743.toml");
    const synchronizedDirectories: string[] = [];
    await assert.rejects(
      backupExpectedDocument(destinationPath, expected, {
        now: new Date(2026, 8, 13, 7, 43),
        syncDirectory: async (directoryPath: string) => {
          synchronizedDirectories.push(directoryPath);
          if (directoryPath === directory) throw new Error("simulated parent directory sync failure");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Backup was retained/u);
        assert.match(error.message, /pi-starship-202609130743\.toml/u);
        assert.match(error.message, /simulated parent directory sync failure/u);
        return true;
      },
    );
    assert.deepEqual(synchronizedDirectories, [path.dirname(retainedPath), directory]);
    assert.deepEqual(readFileSync(retainedPath), expected);

    let removalAttempted = false;
    let diagnosticError: Error | undefined;
    await assert.rejects(
      backupExpectedDocument(destinationPath, expected, {
        now: new Date(2026, 8, 13, 7, 44),
        openFile: async () => ({
          writeFile: async () => {
            throw new Error(`simulated primary failure ${"x".repeat(5000)}`);
          },
          sync: async () => {},
          close: async () => {
            throw new Error("simulated close failure");
          },
        }),
        removeFile: async () => {
          removalAttempted = true;
          throw new Error("simulated removal failure");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        diagnosticError = error;
        assert.match(error.message, /Backup creation failed: simulated primary failure/u);
        assert.match(error.message, /closing the temporary backup: simulated close failure/u);
        assert.match(error.message, /removing the temporary backup: simulated removal failure/u);
        return true;
      },
    );
    assert.equal(removalAttempted, true);
    assert.ok(diagnosticError);
    const { formatError } = await import(scriptSupportUrl);
    const renderedError = formatError(diagnosticError);
    assert.ok(renderedError.length <= 1000, `unbounded error: ${renderedError.length}`);
    assert.match(renderedError, /Backup creation failed: simulated primary failure/u);
    assert.match(renderedError, /closing the temporary backup: simulated close failure/u);
    assert.match(renderedError, /removing the temporary backup: simulated removal failure/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("atomic apply preserves the active document when its durable backup cannot be written", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-skill-backup-failure-"));
  const settingsDirectory = path.join(directory, "agent");
  const destinationPath = path.join(settingsDirectory, "pi-starship.toml");
  const backupDirectory = path.join(settingsDirectory, "pi-starship");
  const draftPath = path.join(directory, "draft.toml");
  const baselinePath = path.join(directory, "baseline.toml");
  const original = 'format = "$model"\n';
  try {
    mkdirSync(settingsDirectory);
    writeFileSync(destinationPath, original);
    writeFileSync(backupDirectory, "occupied");
    writeFileSync(draftPath, 'format = "$directory"\n');
    writeFileSync(baselinePath, original);

    const result = spawnSync(process.execPath, [applyPath, draftPath, destinationPath, baselinePath], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Draft was not applied/u);
    assert.equal(readFileSync(destinationPath, "utf8"), original);
    assert.equal(readFileSync(backupDirectory, "utf8"), "occupied");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

function hasUnsafeTerminalControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint !== 10 && (codePoint < 32 || (codePoint >= 127 && codePoint <= 159))) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function markdownCode(value: unknown): string {
  return `\`${JSON.stringify(value).replaceAll("|", "\\|")}\``;
}

function optionType(kind: string): string {
  return {
    boolean: "boolean",
    integer: "integer",
    string: "string",
    "string-array": "string array",
    "string-enum": "string enum",
    "string-map": "string-to-string table",
  }[kind] as string;
}
