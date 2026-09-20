import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

/** Repository-only split Jiti build policy. See docs/runtime-builder.md for wrapper variations. */
export function createRuntimeBuilder({
  packageRoot,
  temporaryPrefix,
  banner,
  entries,
  forbiddenEagerInputs = [],
  forbiddenEagerExternals = [],
  allowedEagerExternals = [],
  matchExternalSubpaths = true,
  includeDynamicExternals = false,
  validateGraph,
  validateFiles,
}) {
  packageRoot = resolve(packageRoot);
  const entryPoints = entries ?? { index: "src/index.ts" };

  function normalizePath(path) {
    const normalized = path.replaceAll("\\", "/");
    if (!isAbsolute(path)) return `/${normalized.replace(/^\.\//u, "")}`;
    return `/${relative(packageRoot, path).replaceAll("\\", "/")}`;
  }

  function validateEagerGraph(metadata) {
    const outputs = metadata.outputs ?? {};
    const entryPaths = {};
    for (const [name, source] of Object.entries(entryPoints)) {
      const entry = Object.entries(outputs).find(([, output]) =>
        normalizePath(output.entryPoint ?? "").endsWith(`/${source}`),
      );
      if (!entry) throw new Error(`Generated runtime metadata has no ${source} entrypoint`);
      entryPaths[name] = entry[0];
    }
    const allInputs = new Set();
    for (const output of Object.values(outputs)) {
      for (const input of Object.keys(output.inputs ?? {})) {
        const normalized = normalizePath(input);
        allInputs.add(normalized);
        if (normalized.includes("/node_modules/")) throw new Error(`Bundled package input: ${normalized}`);
      }
    }
    const eagerOutputs = collectEagerOutputs(outputs, entryPaths.index);
    const eagerInputs = new Set();
    for (const outputPath of eagerOutputs) {
      const output = outputs[outputPath];
      for (const input of Object.keys(output.inputs ?? {})) eagerInputs.add(normalizePath(input));
      for (const imported of output.imports ?? []) {
        if (
          imported.external &&
          (includeDynamicExternals || imported.kind !== "dynamic-import") &&
          !allowedEagerExternals.includes(imported.path) &&
          forbiddenEagerExternals.some(
            (dependency) =>
              imported.path === dependency || (matchExternalSubpaths && imported.path.startsWith(`${dependency}/`)),
          )
        ) {
          throw new Error(`Eager external dependency: ${imported.path} from ${normalizePath(outputPath)}`);
        }
      }
    }
    for (const forbidden of forbiddenEagerInputs) {
      if ([...eagerInputs].some((input) => input.endsWith(`/${forbidden}`))) {
        throw new Error(`First-use implementation is eager: ${forbidden}`);
      }
    }
    validateGraph?.({ allInputs, eagerInputs, eagerOutputs, entryPaths });
    return { eagerInputs, eagerOutputs };
  }

  async function validateGeneratedFiles(outputDirectory) {
    const files = await listFiles(outputDirectory);
    const runtimeFiles = files.filter((path) => path.endsWith(".ts"));
    if (files.some((path) => path.endsWith(".js"))) throw new Error("Generated runtime retains a .js file");
    for (const name of Object.keys(entryPoints)) {
      if (!runtimeFiles.includes(`${name}.ts`)) throw new Error(`Generated runtime is missing ${name}.ts`);
    }
    if (forbiddenEagerInputs.length > 0 && !runtimeFiles.some((path) => path.startsWith("chunks/"))) {
      throw new Error("Generated runtime has no lazy chunks");
    }

    // Non-bundling parsing inventories actual imports/re-exports, not import-like strings.
    const parsed = await build({
      entryPoints: runtimeFiles.map((file) => resolve(outputDirectory, file)),
      outdir: resolve(outputDirectory, ".validation"),
      bundle: false,
      format: "esm",
      platform: "node",
      metafile: true,
      write: false,
    });
    for (const output of Object.values(parsed.metafile.outputs)) {
      for (const imported of output.imports) {
        if (!imported.path.startsWith("./") && !imported.path.startsWith("../")) continue;
        const target = relative(
          resolve(outputDirectory),
          resolve(dirname(resolve(output.entryPoint)), imported.path),
        ).replaceAll("\\", "/");
        if (!runtimeFiles.includes(target)) {
          throw new Error(
            `Generated relative import has no exact runtime target: ${imported.path} from ${output.entryPoint}`,
          );
        }
      }
    }
    for (const runtimePath of runtimeFiles) {
      const source = await readFile(join(outputDirectory, runtimePath), "utf8");
      if (!source.startsWith(banner)) throw new Error(`Generated marker is missing from ${runtimePath}`);
      if (!files.includes(`${runtimePath}.map`)) throw new Error(`Source map is missing for ${runtimePath}`);
    }
    await validateFiles?.({ outputDirectory, runtimeFiles });
  }

  async function assertSafeOutputDirectory(outputDirectory) {
    const relativeOutput = relative(packageRoot, outputDirectory);
    const firstSegment = relativeOutput.split(sep)[0];
    if (
      relativeOutput === "" ||
      relativeOutput === ".." ||
      relativeOutput.startsWith(`..${sep}`) ||
      isAbsolute(relativeOutput) ||
      (relativeOutput !== "dist" && !firstSegment?.startsWith(`${temporaryPrefix}-build-test-`))
    ) {
      throw new Error("Runtime output directory must be inside the package root and owned by the build");
    }
    const realPackageRoot = await realpath(packageRoot);
    const realOutputParent = await realpath(dirname(outputDirectory));
    // A test-prefix symlink must not redirect publication into source, even inside the package.
    if (realOutputParent !== resolve(realPackageRoot, dirname(relativeOutput))) {
      throw new Error(
        "Runtime output parent must not escape the package root through a symlink or alias unowned paths",
      );
    }
    if ((await statIfPresent(outputDirectory))?.isSymbolicLink()) {
      throw new Error("Runtime output directory must not be a symlink");
    }
  }

  async function publishRuntime(stagingDirectory, outputDirectory, { renamePath = rename } = {}) {
    stagingDirectory = resolve(stagingDirectory);
    outputDirectory = resolve(outputDirectory);
    await assertSafeOutputDirectory(outputDirectory);
    if (stagingDirectory === outputDirectory) throw new Error("Staging and output must differ");
    const testStaging = relative(packageRoot, stagingDirectory)
      .split(sep)[0]
      ?.startsWith(`${temporaryPrefix}-build-test-`);
    if (
      dirname(stagingDirectory) !== dirname(outputDirectory) ||
      (!testStaging && !basename(stagingDirectory).startsWith(`${temporaryPrefix}-dist-`))
    ) {
      throw new Error("Runtime staging directory must be a build-owned sibling of the output");
    }
    if ((await statIfPresent(stagingDirectory))?.isSymbolicLink()) {
      throw new Error("Runtime staging directory must not be a symlink");
    }
    const backupDirectory = `${outputDirectory}.backup-${randomUUID()}`;
    const hadPreviousOutput = Boolean(await statIfPresent(outputDirectory));
    if (hadPreviousOutput) await renamePath(outputDirectory, backupDirectory);
    try {
      await renamePath(stagingDirectory, outputDirectory);
    } catch (error) {
      if (hadPreviousOutput) {
        try {
          await rm(outputDirectory, { force: true, recursive: true });
          await renamePath(backupDirectory, outputDirectory);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Runtime restoration failed; previous output is in ${backupDirectory}`,
          );
        }
      }
      throw error;
    }
    if (hadPreviousOutput) await rm(backupDirectory, { force: true, recursive: true });
  }

  async function buildRuntime({ outputDirectory = join(packageRoot, "dist"), validateOutput } = {}) {
    const resolvedOutputDirectory = resolve(outputDirectory);
    await assertSafeOutputDirectory(resolvedOutputDirectory);
    const stagingDirectory = await mkdtemp(join(dirname(resolvedOutputDirectory), `${temporaryPrefix}-dist-`));
    try {
      const result = await build({
        absWorkingDir: packageRoot,
        banner: { js: banner },
        bundle: true,
        chunkNames: "chunks/[name]-[hash]",
        entryNames: entries ? "[name]" : "index",
        entryPoints: entries ?? ["src/index.ts"],
        format: "esm",
        legalComments: "none",
        metafile: true,
        outExtension: { ".js": ".ts" },
        outdir: stagingDirectory,
        packages: "external",
        platform: "node",
        sourcemap: true,
        splitting: true,
        target: "es2022",
        write: true,
      });
      validateEagerGraph(result.metafile);
      await validateGeneratedFiles(stagingDirectory);
      await validateOutput?.(stagingDirectory);
      await publishRuntime(stagingDirectory, resolvedOutputDirectory);
      return result.metafile;
    } finally {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
  }

  return { buildRuntime, validateEagerGraph, validateGeneratedFiles, publishRuntime };
}

function collectEagerOutputs(outputs, entryPath) {
  const eager = new Set();
  const pending = [entryPath];
  while (pending.length > 0) {
    const outputPath = pending.pop();
    if (!outputPath || eager.has(outputPath)) continue;
    eager.add(outputPath);
    for (const imported of outputs[outputPath]?.imports ?? []) {
      if (imported.external || imported.kind === "dynamic-import") continue;
      if (outputs[imported.path]) pending.push(imported.path);
    }
  }
  return eager;
}

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, relativePath)));
    else if (entry.isFile()) files.push(relativePath.replaceAll("\\", "/"));
    else throw new Error(`Generated runtime contains a non-regular file: ${relativePath}`);
  }
  return files.sort();
}
