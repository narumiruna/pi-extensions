import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { protocolSha256, validateProtocolManifest } from "./protocol.mjs";

const execFileAsync = promisify(execFile);
const PI_PACKAGES = Object.freeze([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
]);
const PROTOCOL_INPUT_PATH = "protocol/manifest.json";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function gitValue(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function discoverTree(root, labelRoot, includeFile) {
  const descriptors = [];
  const visit = async (directory, relativeDirectory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const label = path.posix.join(labelRoot, relativePath.split(path.sep).join(path.posix.sep));
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile() && includeFile(relativePath)) {
        descriptors.push({ absolutePath, path: label });
      }
    }
  };
  await visit(root, "");
  return descriptors;
}

async function runtimeInputDescriptors(packageRoot, protocolPath) {
  const repoRoot = path.resolve(packageRoot, "../..");
  const descriptors = [
    ...(await discoverTree(path.join(packageRoot, "benchmark"), "package/benchmark", (file) => file.endsWith(".mjs"))),
    ...(await discoverTree(path.join(packageRoot, "src"), "package/src", () => true)),
    { absolutePath: path.join(packageRoot, "package.json"), path: "package/package.json" },
    {
      absolutePath: path.join(repoRoot, "package-lock.json"),
      path: "repository/package-lock.json",
    },
  ];
  if (protocolPath) {
    descriptors.push({ absolutePath: path.resolve(protocolPath), path: PROTOCOL_INPUT_PATH });
  }
  return descriptors.sort((left, right) => left.path.localeCompare(right.path));
}

function hashFile(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashInputSet(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.byteLength(file.path, "utf8");
    hash.update(`${pathBytes}:`);
    hash.update(file.path);
    hash.update(`:${file.bytes}:`);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

function assertCapturedProtocol(snapshot, protocol) {
  if (!protocol) return;
  const captured = snapshot.files.find((file) => file.path === PROTOCOL_INPUT_PATH);
  if (!captured) throw new Error("locked protocol manifest was not captured");
  let manifest;
  try {
    manifest = validateProtocolManifest(JSON.parse(captured.content.toString("utf8")));
  } catch (error) {
    throw new Error(
      `Locked protocol manifest changed after argument parsing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (protocolSha256(manifest) !== protocol.sha256) {
    throw new Error("Locked protocol manifest changed after argument parsing");
  }
}

export async function captureRuntimeInputSnapshot({ packageRoot, protocol }) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const descriptors = await runtimeInputDescriptors(resolvedPackageRoot, protocol?.path);
  const files = [];
  for (const descriptor of descriptors) {
    const content = await readFile(descriptor.absolutePath);
    files.push({
      ...descriptor,
      bytes: content.byteLength,
      content,
      sha256: hashFile(content),
    });
  }
  const snapshot = {
    packageRoot: resolvedPackageRoot,
    protocolPath: protocol?.path,
    files,
    sha256: hashInputSet(files),
  };
  assertCapturedProtocol(snapshot, protocol);
  return snapshot;
}

export function publicRuntimeInputSnapshot(snapshot) {
  return {
    sha256: snapshot.sha256,
    files: snapshot.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
}

export async function checkRuntimeInputSnapshot(snapshot) {
  let descriptors;
  try {
    descriptors = await runtimeInputDescriptors(snapshot.packageRoot, snapshot.protocolPath);
  } catch (error) {
    return {
      clean: false,
      changedFiles: ["<runtime-input-scan>"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const baselineByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const currentByPath = new Map(descriptors.map((file) => [file.path, file]));
  const changedFiles = [];
  for (const inputPath of [...new Set([...baselineByPath.keys(), ...currentByPath.keys()])].sort()) {
    const baseline = baselineByPath.get(inputPath);
    const current = currentByPath.get(inputPath);
    if (!baseline || !current) {
      changedFiles.push(inputPath);
      continue;
    }
    try {
      const content = await readFile(current.absolutePath);
      if (content.byteLength !== baseline.bytes || hashFile(content) !== baseline.sha256) {
        changedFiles.push(inputPath);
      }
    } catch {
      changedFiles.push(inputPath);
    }
  }
  return { clean: changedFiles.length === 0, changedFiles };
}

async function lockSnapshotTree(root) {
  const directories = [];
  const visit = async (directory) => {
    directories.push(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else await chmod(child, 0o400);
    }
  };
  await visit(root);
  for (const directory of directories.reverse()) await chmod(directory, 0o500);
}

async function unlockSnapshotTree(root) {
  await chmod(root, 0o700).catch(() => undefined);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await unlockSnapshotTree(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}

export async function createImmutableRuntimeSnapshot({ packageRoot, protocol, snapshotRoot }) {
  const snapshot = await captureRuntimeInputSnapshot({ packageRoot, protocol });
  const extensionContainer = path.join(path.resolve(snapshotRoot), "extension");
  const extensionRoot = path.join(extensionContainer, "src");
  await mkdir(extensionRoot, { recursive: true, mode: 0o700 });
  for (const file of snapshot.files.filter((entry) => entry.path.startsWith("package/src/"))) {
    const relativePath = file.path.slice("package/src/".length);
    const destination = path.join(extensionRoot, ...relativePath.split(path.posix.sep));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { mode: 0o600 });
  }
  const extensionEntry = path.join(extensionRoot, "index.ts");
  if (!snapshot.files.some((file) => file.path === "package/src/index.ts")) {
    await rm(extensionContainer, { recursive: true, force: true });
    throw new Error("extension snapshot has no src/index.ts entrypoint");
  }
  const result = { ...snapshot, extensionContainer, extensionEntry, extensionRoot };
  try {
    await lockSnapshotTree(extensionContainer);
    const initialCheck = await checkRuntimeInputSnapshot(result);
    if (!initialCheck.clean) {
      throw new Error(
        `Runtime inputs changed while creating the immutable snapshot: ${initialCheck.changedFiles.join(", ")}`,
      );
    }
    return result;
  } catch (error) {
    await unlockSnapshotTree(extensionContainer);
    await rm(extensionContainer, { recursive: true, force: true });
    throw error;
  }
}

export async function releaseRuntimeSnapshot(snapshot) {
  if (snapshot?.extensionContainer) await unlockSnapshotTree(snapshot.extensionContainer);
}

export async function collectRuntimeProvenance(packageRoot, protocolPath, runtimeInputSnapshot) {
  const repoRoot = path.resolve(packageRoot, "../..");
  const extensionManifest = await readJson(path.join(packageRoot, "package.json"));
  const piPackageVersions = {};
  for (const packageName of PI_PACKAGES) {
    const manifest = await readJson(path.join(repoRoot, "node_modules", packageName, "package.json"));
    piPackageVersions[packageName] = manifest.version;
  }
  const sourceRevision = await gitValue(repoRoot, ["rev-parse", "HEAD"]);
  const trackedChanges = await gitValue(repoRoot, [
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--",
    "packages/pi-codex-compact/benchmark",
    "packages/pi-codex-compact/src",
    "packages/pi-codex-compact/package.json",
    "package-lock.json",
  ]);
  let protocolManifestTrackedAtSourceRevision;
  if (protocolPath) {
    const relativeProtocolPath = path.relative(repoRoot, path.resolve(protocolPath));
    const insideRepository =
      relativeProtocolPath !== "" &&
      !relativeProtocolPath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeProtocolPath);
    if (!insideRepository) protocolManifestTrackedAtSourceRevision = false;
    else {
      const tracked = await gitValue(repoRoot, ["ls-files", "--error-unmatch", "--", relativeProtocolPath]);
      const unchanged = await gitValue(repoRoot, ["diff", "--quiet", "HEAD", "--", relativeProtocolPath]);
      protocolManifestTrackedAtSourceRevision = tracked !== undefined && unchanged !== undefined;
    }
  }
  return {
    nodeVersion: process.version,
    extensionPackage: {
      name: extensionManifest.name,
      version: extensionManifest.version,
    },
    piPackageVersions,
    estimator: {
      package: "@earendil-works/pi-coding-agent",
      export: "estimateTokens",
    },
    ...(sourceRevision ? { sourceRevision } : {}),
    trackedBenchmarkChangesPresent: trackedChanges === undefined ? undefined : trackedChanges !== "",
    ...(protocolPath ? { protocolManifestTrackedAtSourceRevision } : {}),
    ...(runtimeInputSnapshot
      ? {
          runtimeInputs: {
            ...publicRuntimeInputSnapshot(runtimeInputSnapshot),
            immutableExtensionSnapshot: Boolean(runtimeInputSnapshot.extensionEntry),
            driftDetected: false,
            changedFiles: [],
          },
        }
      : {}),
    provenanceLimit:
      "The hosted model may change under the same ID; provenance identifies the local harness, not a provider-side model revision.",
  };
}
