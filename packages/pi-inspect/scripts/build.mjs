import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Keep this import package-local: root prepare also runs with --omit=dev.
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const stagingPrefix = ".inspect-browser-staging-";
const testPrefix = ".inspect-browser-build-test-";
const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Session Inspector</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertOwnedDirectory(path, staging = false) {
  const name = basename(path);
  if (
    dirname(path) !== resolve(root) ||
    (staging ? !name.startsWith(stagingPrefix) : name !== "browser-dist" && !name.startsWith(testPrefix))
  ) {
    throw new Error("Browser output must be a build-owned direct child of the package root");
  }
  const entry = await statIfPresent(path);
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("Browser output must be a real directory, not a symlink or file");
  }
}

async function validateAssets(directory) {
  for (const file of ["index.html", "app.js", "app.css"]) {
    const entry = await statIfPresent(join(directory, file));
    if (!entry?.isFile() || entry.size === 0) throw new Error(`Browser output is missing a nonempty regular ${file}`);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Browser output contains a non-regular file: ${entry.name}`);
  }
  const source = await readFile(join(directory, "index.html"), "utf8");
  if (!source.includes('href="/app.css"') || !source.includes('src="/app.js"')) {
    throw new Error("Browser HTML must reference app.js and app.css");
  }
}

// Same-filesystem rename publication; simultaneous writers and crash durability are not supported.
export async function publishBrowserAssets(stagingDirectory, outputDirectory, { renamePath = rename } = {}) {
  stagingDirectory = resolve(stagingDirectory);
  outputDirectory = resolve(outputDirectory);
  await assertOwnedDirectory(stagingDirectory, true);
  if (stagingDirectory === outputDirectory) throw new Error("Browser staging and output must differ");
  await validateAssets(stagingDirectory);
  await assertOwnedDirectory(outputDirectory);
  const backup = `${outputDirectory}.backup-${randomUUID()}`;
  const previous = Boolean(await statIfPresent(outputDirectory));
  if (previous) await renamePath(outputDirectory, backup);
  try {
    await renamePath(stagingDirectory, outputDirectory);
  } catch (error) {
    if (previous) {
      try {
        await renamePath(backup, outputDirectory);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `Browser restoration failed; previous output is in ${backup}`);
      }
    }
    throw error;
  }
  if (previous) await rm(backup, { recursive: true, force: true });
}

export async function buildBrowserAssets({
  outputDirectory = join(root, "browser-dist"),
  validateOutput,
  renamePath = rename,
} = {}) {
  outputDirectory = resolve(outputDirectory);
  await assertOwnedDirectory(outputDirectory);
  const staging = await mkdtemp(join(root, stagingPrefix));
  try {
    await build({
      absWorkingDir: root,
      entryPoints: ["src/web/app.tsx"],
      bundle: true,
      outfile: join(staging, "app.js"),
      platform: "browser",
      format: "esm",
      target: "es2024",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      legalComments: "eof",
    });
    await writeFile(join(staging, "index.html"), html);
    // Tests can reject or damage staging; publication still enforces completeness and ownership.
    await validateOutput?.(staging);
    await publishBrowserAssets(staging, outputDirectory, { renamePath });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// scripts/prepare.mjs imports this module for its build side effect.
await buildBrowserAssets();
