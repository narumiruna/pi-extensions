import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";

const repositoryRoot = process.cwd();
const cli = path.join(repositoryRoot, "node_modules/@changesets/cli/bin.js");
const guard = path.join(repositoryRoot, "scripts/check-version-plan.mjs");
const publicName = "@fixture/public";
const privateName = "@fixture/private";
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture({ privateVersion = false, ignored = false, versionless = false, prerelease = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-version-plan-test-"));
  fixtures.push(directory);
  const cwd = path.join(directory, "repository");
  const temp = path.join(directory, "temp");
  const output = path.join(directory, "output");
  mkdirSync(temp);
  writeFileSync(output, "");
  const writeJson = (relativePath: string, value: unknown) => {
    const filename = path.join(cwd, relativePath);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, `${JSON.stringify(value)}\n`);
  };
  const config = JSON.parse(readFileSync(path.join(repositoryRoot, ".changeset/config.json"), "utf8"));
  writeJson("package.json", { name: "fixture-root", private: true, workspaces: ["packages/*"] });
  writeJson("package-lock.json", { lockfileVersion: 3 });
  writeJson("packages/public/package.json", {
    name: publicName,
    ...(versionless ? {} : { version: prerelease ? "1.0.1-next.0" : "1.0.0" }),
  });
  writeJson("packages/private/package.json", { name: privateName, version: "1.0.0", private: true });
  writeJson(".changeset/config.json", {
    ...config,
    ignore: ignored ? [publicName] : [],
    privatePackages: { ...config.privatePackages, version: privateVersion },
  });
  if (prerelease) {
    writeJson(".changeset/pre.json", {
      mode: "pre",
      tag: "next",
    });
    mkdirSync(path.join(cwd, ".changeset/pre"));
    writeFileSync(
      path.join(cwd, ".changeset/pre/already-released.md"),
      `---\n"${publicName}": patch\n---\n\nReleased.\n`,
    );
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });
  git("init", "--quiet", "--initial-branch=main");
  git("add", "package.json", "package-lock.json", "packages", ".changeset");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial fixture");

  return {
    cwd,
    git,
    changeset(name: string, packages: string[]) {
      writeFileSync(
        path.join(cwd, `.changeset/${name}.md`),
        ["---", ...packages.map((name) => `"${name}": patch`), "---", "", "Test release.", ""].join("\n"),
      );
    },
    run() {
      const before = git("status", "--porcelain");
      const result = spawnSync(process.execPath, [guard], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: output, TMPDIR: temp, TMP: temp, TEMP: temp },
      });
      assert.equal(result.error, undefined);
      assert.equal(git("status", "--porcelain"), before, "The guard must not change repository files");
      assert.deepEqual(
        readdirSync(temp).filter((name) => name.startsWith("pi-version-plan-")),
        [],
        "The guard must remove its plan after success or failure",
      );
      return { ...result, output: readFileSync(output, "utf8") };
    },
  };
}

for (const scenario of [
  { title: "private-only changesets", privateVersion: false, target: privateName, expected: false },
  { title: "ignored-only changesets", ignored: true, target: publicName, expected: false },
  { title: "versionless packages", versionless: true, target: publicName, expected: false },
  { title: "empty changesets", target: undefined, expected: false },
  { title: "public package releases", target: publicName, expected: true },
  { title: "private packages with versioning enabled", privateVersion: true, target: privateName, expected: true },
  { title: "new prerelease changesets", prerelease: true, target: publicName, expected: true },
  { title: "already-versioned prerelease changesets", prerelease: true, target: undefined, expected: false },
]) {
  test(`version PR guard handles ${scenario.title}`, () => {
    const repository = fixture(scenario);
    if (!scenario.prerelease || scenario.target)
      repository.changeset("pending", scenario.target ? [scenario.target] : []);
    const result = repository.run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output, `has-releases=${scenario.expected}\n`);
    if (!scenario.expected) assert.match(result.stdout, /No package versions would change/u);
  });
}

test("private-only changesets reproduce the successful no-op version command behind PR 1828", () => {
  const repository = fixture();
  repository.changeset("pending", [privateName]);
  const before = repository.git("status", "--porcelain");
  const version = spawnSync(process.execPath, [cli, "version"], { cwd: repository.cwd, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.equal(repository.git("status", "--porcelain"), before);
  assert.equal(repository.run().output, "has-releases=false\n");
});

test("separate skipped and public changesets still permit a version PR", () => {
  const repository = fixture();
  repository.changeset("private", [privateName]);
  repository.changeset("public", [publicName]);
  const result = repository.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.output, "has-releases=true\n");
});

for (const scenario of [
  { title: "unknown package", packages: ["@fixture/missing"], error: /not in the workspace/u },
  { title: "mixed skipped and versionable packages", packages: [privateName, publicName], error: /mixed changeset/u },
]) {
  test(`version PR guard fails closed for ${scenario.title}`, () => {
    const repository = fixture();
    repository.changeset("invalid", scenario.packages);
    const result = repository.run();
    assert.notEqual(result.status, 0);
    assert.equal(result.output, "");
    assert.match(`${result.stdout}\n${result.stderr}`, scenario.error);
  });
}
