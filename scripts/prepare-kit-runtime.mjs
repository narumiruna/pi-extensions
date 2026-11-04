import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const kitRoot = fileURLToPath(new URL("../packages/pi-tui-kit", import.meta.url));

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, name)));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Kit runtime contains a non-regular file: ${name}`);
  }
  return files.sort();
}

async function outputExists(directory) {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Kit runtime output must be a real directory, not a symlink or file");
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function validateRuntime(packageRoot, staging, metadata) {
  const files = new Set((await listFiles(staging)).map((file) => resolve(staging, file)));
  const runtime = new Set([...files].filter((file) => file.endsWith(".js")));
  if (!runtime.has(join(staging, "index.js"))) throw new Error("Kit runtime is missing index.js");
  for (const file of runtime) {
    if (!files.has(`${file}.map`)) throw new Error(`Kit runtime is missing a source map: ${file}`);
  }
  // Non-bundled esbuild metadata inventories emitted imports, including deferred imports.
  for (const [file, output] of Object.entries(metadata.outputs)) {
    if (!output.entryPoint) continue;
    const emitted = resolve(packageRoot, file);
    if (!runtime.has(emitted)) throw new Error(`Kit runtime is missing an emitted file: ${file}`);
    for (const imported of output.imports) {
      if (!imported.path.startsWith("./") && !imported.path.startsWith("../")) continue;
      if (!runtime.has(resolve(dirname(emitted), imported.path))) {
        throw new Error(`Kit relative import has no exact runtime target: ${imported.path} from ${output.entryPoint}`);
      }
    }
  }
}

// Git installs need runtime JavaScript only; the package build still owns declarations and prepack.
export async function prepareKitRuntime(packageRoot = kitRoot, { renamePath = rename } = {}) {
  packageRoot = await realpath(packageRoot);
  const output = join(packageRoot, "dist");
  await outputExists(output);
  const sources = (await listFiles(join(packageRoot, "src"))).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".d.ts"),
  );
  if (!sources.includes("index.ts")) throw new Error("Kit runtime source is missing index.ts");
  const staging = await mkdtemp(join(packageRoot, ".kit-runtime-staging-"));
  try {
    const result = await build({
      absWorkingDir: packageRoot,
      entryPoints: sources.map((file) => join("src", file)),
      outbase: "src",
      outdir: staging,
      bundle: false,
      format: "esm",
      platform: "node",
      target: "es2024",
      sourcemap: true,
      legalComments: "none",
      metafile: true,
      logLevel: "silent",
    });
    await validateRuntime(packageRoot, staging, result.metafile);
    // Same-filesystem rename publication; simultaneous writers and crash recovery are not supported.
    const backup = join(packageRoot, `.kit-runtime-backup-${randomUUID()}`);
    const previous = await outputExists(output);
    if (previous) await renamePath(output, backup);
    try {
      await renamePath(staging, output);
    } catch (error) {
      if (previous) {
        try {
          await renamePath(backup, output);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `Kit restoration failed; previous output is in ${backup}`);
        }
      }
      throw error;
    }
    if (previous) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
