import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { atomicSaveConfigDocument, normalizeConfig, validateConfigDocument } from "../src/config.js";
import { serializeEffectiveConfig } from "../src/effective-config.js";
import { matchPattern, replacePattern, validPattern } from "../src/format/bounded-regex.js";

const document = `# keep this comment\nformat = '$directory$kubernetes$python'\nfuture = { keep = true }\n[directory]\nrepo_root_format = '[$repo_root]($repo_root_style)$path'\nsubstitutions = [{from = '(work)', to = '$1-space', regex = true}]\n[python]\npython_binary = ['python3', ['py', '-3']]\n[[kubernetes.contexts]]\ncontext_pattern = 'prod-(.*)'\ncontext_alias = '$1'\nstyle = 'bold red'\nsymbol = 'K '\n`;

test("nested capability settings preserve effective TOML and exact saved document bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "starship-capabilities-"));
  try {
    const path = join(directory, "pi-starship.toml");
    const loaded = atomicSaveConfigDocument(path, document);
    assert.equal(readFileSync(path, "utf8"), document);
    assert.equal(loaded.rawDocument, document);
    assert.equal(loaded.diagnostics.length, 1); // unknown root field remains on disk
    const projected = serializeEffectiveConfig(loaded.config);
    const restored = validateConfigDocument(path, projected);
    assert.deepEqual(restored.diagnostics, []);
    for (const name of ["directory", "python", "kubernetes"] as const) {
      assert.deepEqual(restored.config.modules[name].options, loaded.config.modules[name].options);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const value of [
  { contexts: [{ context_pattern: "x", user_pattern: "a".repeat(513) }] },
  { contexts: [{ context_pattern: "x", style: "not-a-style" }] },
  { contexts: [{ context_pattern: "(?=x)" }] },
  { contexts: [{ context_pattern: "(x)\\1" }] },
  { contexts: [{ context_pattern: "x", future: "must-not-activate" }] },
  { contexts: Array.from({ length: 65 }, () => ({ context_pattern: "x" })) },
]) {
  test(`malformed nested rule falls back without retaining a partial active rule: ${JSON.stringify(value).slice(0, 90)}`, () => {
    const loaded = normalizeConfig({ kubernetes: value });
    assert.deepEqual(loaded.config.modules.kubernetes.options.contexts, []);
    assert.equal(loaded.diagnostics[0]?.path, "kubernetes.contexts");
  });
}

for (const python_binary of [
  "",
  [""],
  [["py", "\u001b"]],
  Array.from({ length: 17 }, () => "python"),
  [[...Array.from({ length: 17 }, () => "py")]],
]) {
  test(`invalid interpreter alternatives fall back: ${JSON.stringify(python_binary).slice(0, 90)}`, () => {
    const loaded = normalizeConfig({ python: { python_binary } });
    assert.deepEqual(loaded.config.modules.python.options.python_binary, []);
    assert.equal(loaded.diagnostics[0]?.path, "python.python_binary");
  });
}

test("effective TOML preserves the replacement order of legacy substitution maps", () => {
  const loaded = normalizeConfig({ directory: { substitutions: { z: "a", a: "b" } } });
  const restored = validateConfigDocument("unused.toml", serializeEffectiveConfig(loaded.config));
  assert.deepEqual(restored.diagnostics, []);
  assert.deepEqual(Object.keys(restored.config.modules.directory.options.substitutions), ["z", "a"]);
});

test("scalar interpreter normalizes to an ordered single alternative", () => {
  const loaded = normalizeConfig({ python: { python_binary: "python3" } });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.config.modules.python.options.python_binary, ["python3"]);
});

for (const repo_root_format of ["[", "$unknown", "[$path]($unknown)", "x".repeat(4_097)]) {
  test(`invalid alternative format is inactive: ${repo_root_format.slice(0, 40)}`, () => {
    const loaded = normalizeConfig({ directory: { repo_root_format } });
    assert.equal(loaded.config.modules.directory.options.repo_root_format, "");
    assert.equal(loaded.diagnostics[0]?.path, "directory.repo_root_format");
  });
}

test("bounded regex supports whole matches, captures, replacements, and empty matches", () => {
  assert.equal(matchPattern("a|ab", "ab"), true);
  assert.equal(matchPattern("a", "ba"), false);
  assert.equal(matchPattern("a", "ba", false), true);
  assert.equal(replacePattern("^(?:(a|ab))$", "ab", `\${1}-$$-$missing`), "ab-$-");
  assert.equal(replacePattern("(?P<name>a)", "aba", "$name-", true), "a-ba-");
  assert.equal(replacePattern("", "a", "_", true), "_a_");
  assert.equal(replacePattern("a", "aa", "x"), "xa");
});

test("bounded regex rejects unsupported syntax and bounds source, input, replacement, output, and pathological patterns", () => {
  assert.equal(validPattern("(?=a)"), false);
  assert.equal(validPattern("(a)\\1"), false);
  assert.equal(validPattern("a".repeat(513)), false);
  assert.equal(validPattern(`^(?:${"a".repeat(507)})$`), false);
  assert.equal(matchPattern("a", "a".repeat(4_097)), false);
  assert.equal(replacePattern("a", "a", "x".repeat(4_097)), undefined);
  assert.equal(replacePattern("a", "a".repeat(4_096), "123", true), undefined);
  assert.equal(matchPattern("(a+)+$", `${"a".repeat(4_095)}!`), false);
  for (let index = 0; index < 80; index += 1) assert.equal(validPattern(`x${index}`), true);
  assert.equal(matchPattern("x0", "x0"), true); // eviction does not change behavior
});
