import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "vitest";

const repositoryRoot = process.cwd();
const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");

test("publish workflow starts mode selection only on main without rerunning CI", () => {
  const selectMode = workflow.slice(workflow.indexOf("  select-mode:\n"), workflow.indexOf("  version:\n"));
  assert.match(selectMode, /^ {4}if: github\.ref == 'refs\/heads\/main'$/mu);
  assert.doesNotMatch(selectMode, /^ {4}needs:/mu);
  assert.doesNotMatch(workflow, /^ {2}checks:|ci\.yml|npm (?:run check|test)\b/mu);
});

test("pull request CI retains both checks and tests", () => {
  const ci = readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /^ {2}pull_request:\n {4}branches:\n {6}- main$/mu);
  assert.match(ci, /^ {8}run: npm run check$/mu);
  assert.match(ci, /^ {8}run: npm test -- --ci-shard root$/mu);
  assert.match(ci, /^ {8}run: npm test -- --ci-shard "\$TEST_PACKAGE"$/mu);
});

test("version workflow checks the effective release plan before creating or updating a PR", () => {
  const version = workflow.slice(workflow.indexOf("  version:\n"), workflow.indexOf("  pack:\n"));
  const installIndex = version.indexOf("      - name: Install dependencies\n");
  const guardIndex = version.indexOf("      - name: Check for package version changes\n");
  const actionIndex = version.indexOf("      - name: Create or update version pull request\n");
  assert.ok(installIndex >= 0 && guardIndex > installIndex && actionIndex > guardIndex);
  assert.match(
    version.slice(guardIndex, actionIndex),
    /id: release-plan\n {8}run: node \.\/\.github\/scripts\/check-version-plan\.mjs/u,
  );
  assert.match(
    version.slice(actionIndex),
    /if: steps\.release-plan\.outputs\.has-releases == 'true'\n {8}uses: changesets\/action\/version@/u,
  );
  assert.match(version.slice(actionIndex), /script: npm run version-packages/u);
});

function job(name: string) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.ok(start >= 0, `Missing ${name} job`);
  return workflow.slice(start).split(/\n(?= {2}[\w-]+:\n)/u)[0];
}

test("publish mode runs the three stages in success order using the original commit and pack output", () => {
  assert.match(job("pack"), /needs: select-mode\n {4}if: needs\.select-mode\.outputs\.mode == 'publish'/u);
  const stages = [
    ["publish-prerequisites", "pack"],
    ["verify-registry", "[pack, publish-prerequisites]"],
    ["publish", "[pack, verify-registry]"],
  ];
  for (const [name, needs] of stages) {
    const section = job(name);
    assert.ok(section.includes(`\n    needs: ${needs}\n`));
    // The implicit success() must not be overridden, even on job reruns.
    assert.doesNotMatch(section, /^ {4}(?:if:|continue-on-error:)|continue-on-error|run-id:|\bref:|upload-artifact/mu);
    assert.match(section, /actions\/checkout@[a-f0-9]{40}.*\n(?:.*\n)*? {10}persist-credentials: false/u);
    assert.doesNotMatch(section, /publish-coordinated-packages|publish-packages:sequential|npm run build|npm pack/u);
  }
  const first = job("publish-prerequisites");
  assert.match(
    first,
    /&download-packed-packages\n {8}name: Download packed packages\n {8}uses: actions\/download-artifact@[a-f0-9]{40}/u,
  );
  assert.match(
    first,
    /artifact-ids: \$\{\{ needs\.pack\.outputs\.pack-dir-artifact-id \|\| 'missing-pack-dir-artifact-id' \}\}/u,
  );
  for (const name of ["verify-registry", "publish"]) assert.match(job(name), /- \*download-packed-packages/u);
  assert.equal(workflow.match(/actions\/download-artifact@/gu)?.length, 1);
  assert.equal(workflow.match(/run: npm run build/gu)?.length, 1);
});

test("only publishing stages run the pinned native Action with provenance and publication permissions", () => {
  const gate = job("verify-registry");
  assert.match(gate, /permissions:\n {6}contents: read\n {4}steps:/u);
  assert.match(
    gate,
    /run: npm run publish-packages -- --from-pack-dir "\$RUNNER_TEMP\/changeset-pack" --stage verify-registry$/mu,
  );
  assert.doesNotMatch(gate, /changesets\/action\/publish|token|secrets\.|NPM_CONFIG_PROVENANCE|summarize-published/u);
  for (const [name, stage] of [
    ["publish-prerequisites", "prerequisites"],
    ["publish", "remaining"],
  ]) {
    const section = job(name);
    assert.match(section, /contents: write.*\n {6}id-token: write/u);
    assert.match(section, /uses: changesets\/action\/publish@ae32849d5ba541f9ae29e40e22a623bc13562f51/u);
    assert.ok(
      section.includes(
        `script: npm run publish-packages -- --from-pack-dir \${{ runner.temp }}/changeset-pack --stage ${stage}\n`,
      ),
    );
    assert.match(section, /create-github-releases: true/u);
    assert.match(section, /push-git-tags: true/u);
    assert.match(section, /NPM_CONFIG_PROVENANCE: "true"/u);
    assert.doesNotMatch(section, /secrets\.|PAT_TOKEN/u);
  }
  assert.equal(workflow.match(/id-token: write/gu)?.length, 2);
  assert.match(
    job("publish-prerequisites"),
    /&summarize-published-packages\n {8}name: Summarize published packages\n {8}if: always\(\)/u,
  );
  assert.match(job("publish"), /- \*summarize-published-packages/u);
  assert.match(job("version"), /github-token: \$\{\{ secrets\.PAT_TOKEN \}\}/u);
});

test("packed and legacy npm commands keep their existing entrypoints", () => {
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(manifest.scripts["publish-packages"], "node ./.github/scripts/publish-packed-packages.mjs");
  assert.equal(
    manifest.scripts["publish-packages:sequential"],
    "node ./.github/scripts/publish-packages-sequentially.mjs",
  );
});

test("publish workflow builds before packing and disables lifecycle scripts only in the pack step", () => {
  const packJob = job("pack");
  const buildIndex = packJob.indexOf("      - name: Build packages\n");
  const packIndex = packJob.indexOf("      - name: Pack packages\n");
  assert.ok(buildIndex >= 0 && packIndex > buildIndex);
  assert.match(packJob.slice(buildIndex, packIndex), /run: npm run build/u);
  assert.match(packJob.slice(packIndex), /\n {8}env:\n(?: {10}#[^\n]*\n)* {10}NPM_CONFIG_IGNORE_SCRIPTS: "true"\n/u);
  assert.equal(workflow.match(/NPM_CONFIG_IGNORE_SCRIPTS/gu)?.length, 1);
  assert.doesNotMatch(packJob.slice(0, packIndex), /--ignore-scripts/u);
});

test("native Changesets packs prebuilt dependencies and consumers without lifecycle rebuilds", () => {
  const ignoreScripts = workflow.match(/^ {10}NPM_CONFIG_IGNORE_SCRIPTS: "(true)"$/mu)?.[1];
  assert.equal(ignoreScripts, "true");
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-prebuilt-pack-"));
  try {
    const writeJson = (relativePath: string, value: unknown) => {
      const file = path.join(fixture, relativePath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(value)}\n`);
    };
    writeJson("package.json", { name: "pack-fixture", private: true, workspaces: ["packages/*"] });
    writeJson("package-lock.json", { lockfileVersion: 3 });
    mkdirSync(path.join(fixture, ".changeset"));
    copyFileSync(path.join(repositoryRoot, ".changeset/config.json"), path.join(fixture, ".changeset/config.json"));
    const names = ["@fixture/library", "@fixture/consumer"];
    const failRebuild = "node -e \"throw new Error('Packing must use the completed build')\"";
    for (const [index, name] of names.entries()) {
      const directory = `packages/${path.basename(name)}`;
      writeJson(`${directory}/package.json`, {
        name,
        version: "1.0.0",
        files: ["dist"],
        main: "dist/index.js",
        scripts: { prepack: failRebuild, prepare: failRebuild, postpack: failRebuild },
        ...(index ? { dependencies: { [names[0]]: "^1.0.0" } } : {}),
      });
      mkdirSync(path.join(fixture, directory, "dist"));
      writeFileSync(path.join(fixture, directory, "dist/index.js"), `module.exports = ${JSON.stringify(name)};\n`);
    }
    writeJson("publish-plan.json", {
      version: 1,
      plan: names.map((name) => [{ kind: "publish", name, version: "1.0.0", access: "public", tag: "latest" }]),
    });
    // An explicit plan keeps the installed CLI offline; only real npm packing runs.
    const result = spawnSync(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules/@changesets/cli/bin.js"),
        "pack",
        "--from-publish-plan",
        "publish-plan.json",
        "--out-dir",
        "packed",
      ],
      {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, npm_config_ignore_scripts: undefined, NPM_CONFIG_IGNORE_SCRIPTS: ignoreScripts },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const plan = JSON.parse(readFileSync(path.join(fixture, "packed/publish-plan.json"), "utf8"));
    const releases = plan.plan.flat() as { name: string; tarball: { path: string } }[];
    assert.deepEqual(
      releases.map(({ name }) => name),
      names,
    );
    for (const release of releases) {
      const archive = gunzipSync(readFileSync(path.join(fixture, "packed", release.tarball.path)));
      assert.ok(archive.includes(Buffer.from("package/dist/index.js")));
      assert.ok(archive.includes(Buffer.from(`module.exports = ${JSON.stringify(release.name)};\n`)));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
