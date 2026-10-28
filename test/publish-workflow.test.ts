import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "vitest";

const repositoryRoot = process.cwd();
const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");

test("publish workflow uses native Changesets artifact publishing without duplicate root gates", () => {
  const publish = workflow.slice(workflow.indexOf("  publish:\n"));
  assert.match(publish, /actions\/download-artifact@[a-f0-9]{40}/u);
  assert.match(publish, /artifact-ids: \$\{\{ needs\.pack\.outputs\.pack-dir-artifact-id \}\}/u);
  assert.match(
    publish,
    /script: npm run publish-packages -- --from-pack-dir \$\{\{ runner\.temp \}\}\/changeset-pack/u,
  );
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(manifest.scripts["publish-packages"], "node ./scripts/publish-packed-packages.mjs");
  assert.match(publish, /create-github-releases: true/u);
  assert.match(publish, /push-git-tags: true/u);
  assert.match(publish, /NPM_CONFIG_PROVENANCE: "true"/u);
  assert.match(publish, /if: always\(\)/u);
  assert.doesNotMatch(publish, /npm (?:run check|test)/u);
  assert.doesNotMatch(publish, /publish-coordinated-packages|npm view|npm pack/u);
});

test("publish workflow builds before packing and disables lifecycle scripts only in the pack step", () => {
  const packJob = workflow.slice(workflow.indexOf("  pack:\n"), workflow.indexOf("  publish:\n"));
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
