import * as fs from "node:fs";
import * as path from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const CORE_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_DISPLAY_PATH_BYTES = 500;

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface PiInvocationRuntime {
  execPath: string;
  packageDir: string;
  runtimeKind: "node" | "bun" | "unsupported";
}

export class PiInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiInvocationError";
  }
}

export function resolvePiInvocation(args: string[], runtime: PiInvocationRuntime = currentRuntime()): PiInvocation {
  const packageDirectory = existingDirectory(runtime.packageDir);
  const manifest = readManifest(packageDirectory);
  const declaredBin = resolveDeclaredBin(packageDirectory, manifest);
  const standalone = resolveStandaloneExecutable(packageDirectory, runtime);
  if (standalone) return { command: standalone, args: [...args] };
  if (runtime.runtimeKind !== "node" && runtime.runtimeKind !== "bun") {
    throw resolutionError(packageDirectory, "the host does not provide Node or Bun");
  }
  return {
    command: runtime.execPath,
    args: [resolveExistingFile(packageDirectory, declaredBin, "the declared bin.pi target is unavailable"), ...args],
  };
}

function currentRuntime(): PiInvocationRuntime {
  let packageDir: string;
  try {
    packageDir = getPackageDir();
  } catch {
    throw resolutionError("<unavailable>", "Pi core did not provide its package directory");
  }
  return {
    execPath: process.execPath,
    packageDir,
    runtimeKind: process.versions.bun
      ? "bun"
      : process.release.name === "node" && !process.versions.electron
        ? "node"
        : "unsupported",
  };
}

function existingDirectory(value: string): string {
  try {
    const resolved = fs.realpathSync(value);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw resolutionError(value, "the package directory is unavailable");
  }
}

function readManifest(packageDirectory: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  } catch {
    throw resolutionError(packageDirectory, "the package manifest is unavailable or invalid");
  }
  if (!isRecord(value) || value.name !== CORE_PACKAGE_NAME) {
    throw resolutionError(packageDirectory, "the package manifest has an unexpected package name");
  }
  return value;
}

function resolveDeclaredBin(packageDirectory: string, manifest: Record<string, unknown>): string {
  const bin = manifest.bin;
  const piBin = isRecord(bin) ? bin.pi : undefined;
  if (typeof piBin !== "string" || !piBin.trim()) {
    throw resolutionError(packageDirectory, "package.json bin.pi must be a non-empty string");
  }
  const candidate = path.resolve(packageDirectory, piBin);
  if (path.isAbsolute(piBin) || !isWithin(packageDirectory, candidate)) {
    throw resolutionError(packageDirectory, "the declared bin.pi target escapes the package");
  }
  return candidate;
}

function resolveExistingFile(packageDirectory: string, candidate: string, reason: string): string {
  try {
    const resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
    if (!isWithin(packageDirectory, resolved)) {
      throw resolutionError(packageDirectory, "the declared bin.pi target escapes the package");
    }
    return resolved;
  } catch (error) {
    if (error instanceof PiInvocationError) throw error;
    throw resolutionError(packageDirectory, reason);
  }
}

function resolveStandaloneExecutable(packageDirectory: string, runtime: PiInvocationRuntime): string | undefined {
  if (runtime.runtimeKind !== "bun" || !/^pi(?:\.exe)?$/iu.test(path.basename(runtime.execPath))) {
    return undefined;
  }
  let resolved: string;
  let mode: number;
  try {
    resolved = fs.realpathSync(runtime.execPath);
    const info = fs.statSync(resolved);
    if (!info.isFile()) throw new Error("not a file");
    mode = info.mode;
  } catch {
    throw resolutionError(packageDirectory, "the standalone Pi executable is unavailable");
  }
  if (path.dirname(resolved) !== packageDirectory) return undefined;
  if (process.platform !== "win32" && (mode & 0o111) === 0) {
    throw resolutionError(packageDirectory, "the standalone Pi executable is not executable");
  }
  return resolved;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolutionError(packageDirectory: string, reason: string): PiInvocationError {
  const displayed = Buffer.from(packageDirectory).subarray(0, MAX_DISPLAY_PATH_BYTES).toString();
  return new PiInvocationError(
    `Unable to resolve the Pi CLI from ${JSON.stringify(displayed)}: ${reason}. Reinstall the matching Pi core package before spawning a session.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
