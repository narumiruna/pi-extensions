import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { createNpmRegistry, expectSuccess, repositoryRoot } from "./npm-install-fixture.js";

const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
let registry: Awaited<ReturnType<typeof createNpmRegistry>>;
beforeAll(async () => {
  registry = await createNpmRegistry();
});
afterEach(() => registry?.cancelCommands());
afterAll(async () => {
  await registry?.close();
});

function scriptFixture(allowScripts?: Record<string, boolean>) {
  return registry.fixture({ dependencies: { "policy-script": "1.0.0" }, ...(allowScripts ? { allowScripts } : {}) });
}

async function lock(cwd: string, extra: string[] = []) {
  expectSuccess(await registry.npm(cwd, ["install", "--package-lock-only", "--ignore-scripts", ...extra]));
}

for (const [label, allowScripts, execution] of [
  ["approved", { "policy-script@1.0.0": true }, true],
  ["denied", { "policy-script": false }, false],
] as const) {
  test(`${label} dependency scripts follow the repository policy`, async () => {
    const cwd = scriptFixture(allowScripts);
    await lock(cwd);
    const before = readFileSync(path.join(cwd, "package-lock.json"), "utf8");
    expectSuccess(await registry.npm(cwd, ["ci"]));
    assert.equal(registry.marker(cwd), execution);
    assert.equal(readFileSync(path.join(cwd, "package-lock.json"), "utf8"), before);
  });
}

test("unreviewed scripts fail for the policy reason before execution", async () => {
  const cwd = scriptFixture();
  await lock(cwd);
  const result = await registry.npm(cwd, ["ci"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ESTRICTALLOWSCRIPTS/u);
  assert.equal(registry.marker(cwd), false);
  assert.ok(registry.requests.includes("/policy-script"));
  // Same registry and artifact succeed when reviewed, ruling out setup/network failure.
  writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "consumer",
      version: "1.0.0",
      dependencies: { "policy-script": "1.0.0" },
      allowScripts: { "policy-script@1.0.0": true },
    }),
  );
  expectSuccess(await registry.npm(cwd, ["ci"]));
  assert.equal(registry.marker(cwd), true);
});

test("a version approval does not silently approve the next version", async () => {
  const cwd = registry.fixture({
    dependencies: { "policy-script": "1.0.1" },
    allowScripts: { "policy-script@1.0.0": true },
  });
  await lock(cwd, ["--min-release-age=0"]);
  const result = await registry.npm(cwd, ["ci"]);
  assert.match(result.stderr, /ESTRICTALLOWSCRIPTS/u);
  assert.notEqual(result.code, 0);
  assert.equal(registry.marker(cwd), false);
});

test("script-free and incompatible optional dependencies require no approval", async () => {
  const cwd = registry.fixture({
    dependencies: { "policy-plain": "1.0.0" },
    optionalDependencies: { "policy-incompatible": "1.0.0" },
  });
  await lock(cwd);
  expectSuccess(await registry.npm(cwd, ["ci"]));
  assert.equal(registry.lockedVersion(cwd), "1.0.0");
  assert.equal(existsSync(path.join(cwd, "node_modules/policy-incompatible")), false);
});

test("manifest/lockfile mismatch fails without replacing the lockfile", async () => {
  const cwd = registry.fixture({ dependencies: { "policy-plain": "1.0.0" } });
  await lock(cwd);
  const before = readFileSync(path.join(cwd, "package-lock.json"), "utf8");
  writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "consumer", version: "1.0.0", dependencies: { "policy-plain": "1.0.1" } }),
  );
  const result = await registry.npm(cwd, ["ci", "--min-release-age=0"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /EUSAGE/u);
  assert.match(result.stderr, /Invalid: lock file/u);
  assert.equal(readFileSync(path.join(cwd, "package-lock.json"), "utf8"), before);
});

test("fresh lockfile-only range resolution excludes too-recent versions", async () => {
  const cwd = registry.fixture({ dependencies: { "policy-plain": "^1.0.0" } });
  await lock(cwd);
  assert.equal(registry.lockedVersion(cwd), "1.0.0");
});

for (const spec of ["1.0.1", "^1.0.1"]) {
  test(`fresh lockfile-only ${spec} fails when no age-eligible version satisfies it`, async () => {
    const cwd = registry.fixture({ dependencies: { "policy-plain": spec } });
    const result = await registry.npm(cwd, ["install", "--package-lock-only", "--ignore-scripts"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ETARGET/u);
    assert.equal(existsSync(path.join(cwd, "package-lock.json")), false);
  });
}

test("age filtering does not audit a young existing lock during maintenance or ci", async () => {
  const cwd = registry.fixture({ dependencies: { "policy-plain": "1.0.1" } });
  await lock(cwd, ["--min-release-age=0"]);
  await lock(cwd);
  expectSuccess(await registry.npm(cwd, ["ci"]));
  assert.equal(registry.lockedVersion(cwd), "1.0.1");
});

function preflightFixture() {
  const cwd = registry.fixture({ allowScripts: { "policy-script": false } });
  mkdirSync(path.join(cwd, "scripts"));
  // Exercise policy checks with the test runtime, not the repository's CI pins.
  // The version guards remain active and are tested with explicit mismatches below.
  const script = readFileSync(path.join(repositoryRoot, "scripts/check-install-policy.mjs"), "utf8");
  const npmPin = /const expectedNpm = "[^"]+";/u;
  assert.match(script, npmPin);
  writeFileSync(
    path.join(cwd, "scripts/check-install-policy.mjs"),
    script.replace(npmPin, `const expectedNpm = ${JSON.stringify(npmVersion)};`),
  );
  writeFileSync(path.join(cwd, ".node-version"), `${process.versions.node}\n`);
  return cwd;
}

for (const [key, value] of [
  ["strict_allow_scripts", "false"],
  ["min_release_age", "0"],
  ["ignore_scripts", "true"],
  ["dangerously_allow_all_scripts", "true"],
  ["min_release_age_exclude", "policy-plain"],
  ["before", "2099-01-01"],
  ["allow_scripts", "policy-script"],
  ["allow-scripts", "policy-script"],
  ["ALLOW_SCRIPTS", "policy-script"],
]) {
  test(`preflight rejects effective npm_config_${key} override`, async () => {
    const cwd = preflightFixture();
    const result = await registry.command(cwd, ["scripts/check-install-policy.mjs"], { [`npm_config_${key}`]: value });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unexpected npm|environment override/u);
  });
}

test("preflight accepts the validated baseline and ignored lower-priority allow-scripts", async () => {
  const cwd = preflightFixture();
  writeFileSync(path.join(registry.root, "user.npmrc"), "allow-scripts=policy-script\n");
  try {
    expectSuccess(await registry.command(cwd, ["scripts/check-install-policy.mjs"]));
    const manifest = {
      name: "consumer",
      version: "1.0.0",
      dependencies: { "policy-script": "1.0.0" },
      allowScripts: { "policy-script": false },
    };
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify(manifest));
    await lock(cwd);
    expectSuccess(await registry.npm(cwd, ["ci"]));
    assert.equal(registry.marker(cwd), false);
  } finally {
    writeFileSync(path.join(registry.root, "user.npmrc"), "");
  }
});

test("preflight fails on an unexpected npm version without logging configuration", async () => {
  const cwd = preflightFixture();
  const bin = path.join(cwd, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npm"), "#!/usr/bin/env node\nconsole.log('0.0.0');\n");
  chmodSync(path.join(bin, "npm"), 0o755);
  const result = await registry.command(cwd, ["scripts/check-install-policy.mjs"], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /bundled npm/u);
  assert.equal(result.stdout, "");
});

test("preflight refuses unreadable npm policy without leaking command output", async () => {
  const cwd = preflightFixture();
  const bin = path.join(cwd, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log(${JSON.stringify(npmVersion)});
else { console.error('fixture-secret-do-not-log'); process.exitCode = 1; }
`,
  );
  chmodSync(path.join(bin, "npm"), 0o755);
  const result = await registry.command(cwd, ["scripts/check-install-policy.mjs"], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Could not read npm installation policy/u);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret-do-not-log/u);
});

test("preflight rejects mismatched Node and command-line overrides", async () => {
  const cwd = preflightFixture();
  writeFileSync(path.join(cwd, ".node-version"), "0.0.0\n");
  const nodeMismatch = await registry.command(cwd, ["scripts/check-install-policy.mjs"]);
  assert.notEqual(nodeMismatch.code, 0);
  assert.match(nodeMismatch.stderr, /Use Node.js from \.node-version/u);
  assert.equal(nodeMismatch.stdout, "");
  const result = await registry.command(cwd, ["scripts/check-install-policy.mjs", "--ignore-scripts"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /command-line overrides/u);
});

test("version-packages retains age filtering in its actual lockfile-only command", async () => {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = manifest.scripts["version-packages"]?.split(" && ")[1];
  assert.equal(command, "npm install --package-lock-only --ignore-scripts");
  const cwd = registry.fixture({ dependencies: { "policy-plain": "1.0.1" } });
  const result = await registry.npm(cwd, command.split(" ").slice(1));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ETARGET/u);
});

test("dependency updater fails on a too-recent exact proposal and leaves recoverable edits", async () => {
  const cwd = registry.fixture({ dependencies: { "policy-plain": "1.0.0" } });
  await lock(cwd);
  mkdirSync(path.join(cwd, "node_modules/.bin"), { recursive: true });
  const ncu = path.join(cwd, "node_modules/.bin/npm-check-updates");
  writeFileSync(
    ncu,
    `#!/usr/bin/env node
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('package.json'));
manifest.dependencies['policy-plain'] = '1.0.1';
fs.writeFileSync('package.json', JSON.stringify(manifest));
fs.writeFileSync('node_modules/proposal-args.json', JSON.stringify(process.argv.slice(2)));
`,
  );
  chmodSync(ncu, 0o755);
  writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd, env: registry.env, stdio: "pipe" });
  git(["init", "-q"]);
  git(["add", "package.json", "package-lock.json", ".npmrc", ".gitignore"]);
  git([
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-qm",
    "fixture",
  ]);
  const before = readFileSync(path.join(cwd, "package-lock.json"), "utf8");
  const result = await registry.command(cwd, [path.join(repositoryRoot, "scripts/run-dependency-update.mjs"), "lock"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ETARGET/u);
  assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, "node_modules/proposal-args.json"), "utf8")), [
    "--workspaces",
    "--root",
    "-u",
  ]);
  assert.equal(JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).dependencies["policy-plain"], "1.0.1");
  assert.equal(readFileSync(path.join(cwd, "package-lock.json"), "utf8"), before);
});
