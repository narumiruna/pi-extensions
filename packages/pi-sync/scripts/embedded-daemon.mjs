import { chmod, copyFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire, findPackageJSON, isBuiltin } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import semver from "semver";
import { readDaemonBuild } from "../../pi-sync-daemon/scripts/build-record.mjs";

export const daemonName = "@narumitw/pi-sync-daemon";
export const embeddedAlias = "#pi-sync-daemon";
export const embeddedDirectory = "daemon";
const sdkAlias = "@narumitw/sync-node-sdk";
const sdkPackage = "@earendil-works/pi-coding-agent";
const sdkPeers = ["@earendil-works/pi-ai", "@earendil-works/pi-tui"];
const sdkPackages = [sdkPackage, ...sdkPeers];
const bootstrapImport = 'import "./child-sdk.mjs";';
const daemonRoot = fileURLToPath(new URL("../../pi-sync-daemon", import.meta.url));
const clientManifest = new URL("../package.json", import.meta.url);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const workspaceRequire = createRequire(clientManifest);

function embeddedImports(exports) {
  const mappings = {};
  for (const name of [".", "./engine/*"]) {
    const target = exports[name]?.default;
    if (target !== (name === "." ? "./dist/index.js" : "./dist/engine/*.js")) {
      throw new Error(`Unexpected workspace daemon export: ${name}`);
    }
    mappings[name === "." ? embeddedAlias : `${embeddedAlias}${name.slice(1)}`] =
      `./${embeddedDirectory}/${target.slice(2)}`;
  }
  return mappings;
}

export async function stageDaemon(outputDirectory) {
  const { manifest, files } = await readDaemonBuild(daemonRoot);
  const daemon = JSON.parse(manifest);
  const client = await readJson(clientManifest);
  const range = client.devDependencies?.[daemonName];
  if (daemon.name !== daemonName || !range || !semver.satisfies(daemon.version, range, { includePrerelease: true })) {
    throw new Error(`Workspace daemon ${daemon.version} does not match selected build range ${range}.`);
  }
  const workspaceEntry = await realpath(join(daemonRoot, "dist", "index.js"));
  if ((await realpath(workspaceRequire.resolve(daemonName))) !== workspaceEntry) {
    throw new Error("Pi Sync must use the local workspace daemon build, not a registry copy.");
  }
  await verifyDependencies(client, daemon);
  const directory = join(outputDirectory, embeddedDirectory);
  const nativeDirectory = join(directory, "dist");
  const cli = files.get("cli.js")?.toString("utf8");
  if (!cli?.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("Missing or unexpected workspace daemon CLI.");
  }
  files.set("cli.js", cli.replace("\n", `\n${bootstrapImport}\n`));
  if (files.has("cli.js.map")) {
    const map = JSON.parse(files.get("cli.js.map").toString("utf8"));
    map.mappings = map.mappings.replace(/^[^;]*/u, "$&;");
    files.set("cli.js.map", JSON.stringify(map));
  }
  for (const [path, bytes] of files) {
    const target = join(nativeDirectory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await chmod(join(nativeDirectory, "cli.js"), 0o755);
  await copyFile(new URL("./child-sdk.mjs", import.meta.url), join(nativeDirectory, "child-sdk.mjs"));
  await copyFile(join(daemonRoot, "LICENSE"), join(directory, "LICENSE"));
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ version: daemon.version }, null, 2)}\n`);
  await writeFile(
    join(outputDirectory, "package.json"),
    `${JSON.stringify({ imports: embeddedImports(daemon.exports) }, null, 2)}\n`,
  );
}

async function verifyDependencies(client, daemon) {
  for (const [name, range] of Object.entries(daemon.dependencies)) {
    if (sdkPackages.includes(name)) continue;
    if (client.dependencies?.[name] !== range) {
      throw new Error(`Pi Sync runtime dependency must match the daemon's ${name}@${range}.`);
    }
  }
  const pin = daemon.dependencies[sdkPackage];
  const sdkManifest = findPackageJSON(sdkAlias, clientManifest);
  const sdk = sdkManifest && (await readJson(sdkManifest));
  if (
    client.dependencies?.[sdkAlias] !== `npm:${sdkPackage}@${pin}` ||
    sdk?.name !== sdkPackage ||
    sdk.version !== pin
  ) {
    throw new Error("The embedded daemon SDK alias must match the daemon's pinned SDK.");
  }
  for (const name of sdkPeers) {
    const dependency = await readJson(findPackageJSON(name, sdkManifest));
    if (sdk.dependencies[name] !== daemon.dependencies[name] || dependency.version !== daemon.dependencies[name]) {
      throw new Error(`The embedded daemon SDK must supply the daemon's pinned ${name}.`);
    }
  }
}

export async function validateDaemon({ outputDirectory, imports }) {
  const daemon = await readJson(join(daemonRoot, "package.json"));
  const layout = await readJson(join(outputDirectory, "package.json"));
  const expectedImports = embeddedImports(daemon.exports);
  if (JSON.stringify(layout.imports) !== JSON.stringify(expectedImports)) {
    throw new Error("Unexpected embedded daemon import mapping.");
  }
  const directory = join(outputDirectory, embeddedDirectory);
  const metadata = await readJson(join(directory, "package.json"));
  if (metadata.version !== daemon.version || Object.hasOwn(metadata, "type")) {
    throw new Error("Invalid embedded daemon version or module scope.");
  }
  await readFile(join(directory, "LICENSE"));
  const runtimeDirectory = join(directory, "dist");
  const files = (await readdir(runtimeDirectory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.m?js$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  const nativeFiles = new Set(files);
  for (const entry of ["index.js", "cli.js", "child-sdk.mjs", "build-version.js"]) {
    if (!nativeFiles.has(join(runtimeDirectory, entry))) throw new Error(`Embedded daemon is missing ${entry}.`);
  }
  const hostTargets = new Set();
  for (const { path } of imports) {
    if (path === daemonName || path.startsWith(`${daemonName}/`)) {
      throw new Error(`Generated runtime retains a daemon registry import: ${path}`);
    }
    if (path === sdkAlias) throw new Error("Generated host runtime references the child SDK.");
    if (path !== embeddedAlias && !path.startsWith(`${embeddedAlias}/`)) continue;
    const prefix = `${embeddedAlias}/engine/`;
    const target =
      expectedImports[path] ??
      (path.startsWith(prefix) && expectedImports[`${prefix}*`].replace("*", path.slice(prefix.length)));
    const resolved = target && resolve(outputDirectory, target);
    if (!resolved?.startsWith(`${runtimeDirectory}${sep}`) || !nativeFiles.has(resolved)) {
      throw new Error(`Embedded daemon import has no exact runtime target: ${path}`);
    }
    hostTargets.add(resolved);
  }
  const parsed = await build({
    entryPoints: files,
    outdir: join(outputDirectory, ".native-validation"),
    bundle: false,
    format: "esm",
    platform: "node",
    metafile: true,
    write: false,
  });
  const edges = new Map(Object.values(parsed.metafile.outputs).map((file) => [resolve(file.entryPoint), file.imports]));
  for (const [file, dependencies] of edges) {
    for (const { path } of dependencies) {
      if (path.startsWith("./") || path.startsWith("../")) {
        if (!nativeFiles.has(resolve(dirname(file), path))) {
          throw new Error(`Embedded daemon relative import has no exact runtime target: ${path} from ${file}`);
        }
      } else if (!isBuiltin(path) && !Object.hasOwn(daemon.dependencies, path)) {
        throw new Error(`Undeclared embedded daemon import: ${path} from ${file}`);
      }
    }
  }
  validateCliBootstrap(edges, runtimeDirectory);
  for (const [file] of reachableModules(edges, hostTargets)) {
    if (["cli.js", "child-sdk.mjs"].some((name) => file === join(runtimeDirectory, name))) {
      throw new Error("Embedded host graph reaches the Node-only CLI or SDK bootstrap.");
    }
  }
}

function validateCliBootstrap(edges, runtimeDirectory) {
  const cli = join(runtimeDirectory, "cli.js");
  if (!edges.get(cli).some(({ path, kind }) => path === "./child-sdk.mjs" && kind === "import-statement")) {
    throw new Error("Embedded daemon CLI is missing the SDK bootstrap.");
  }
  for (const [, imports] of reachableModules(edges, [cli], true)) {
    for (const { path } of imports) {
      if (sdkPackages.includes(path)) throw new Error(`Embedded CLI imports ${path} before installing SDK resolution.`);
    }
  }
}

function* reachableModules(edges, entries, staticOnly = false) {
  const visited = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const imports = edges.get(file).filter(({ kind }) => !staticOnly || kind !== "dynamic-import");
    yield [file, imports];
    for (const { path } of imports) {
      if (path.startsWith("./") || path.startsWith("../")) pending.push(resolve(dirname(file), path));
    }
  }
}
