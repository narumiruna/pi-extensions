import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { runPublishCommand as runChild } from "./publish-command.mjs";

const require = createRequire(import.meta.url);
const cli = require.resolve("@changesets/cli/bin.js");
// Resolve public APIs in the native CLI's scope so discovery and graph semantics agree.
const cliRequire = createRequire(cli);
const { getPackages } = await import(cliRequire.resolve("@manypkg/get-packages"));
const { getDependentsGraph } = await import(cliRequire.resolve("@changesets/get-dependents-graph"));
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest("base64");
const readinessTimeout = 30_000;
const availabilityDelay = 2_000;
const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNECTIONTIMEOUT",
  "EIDLETIMEOUT",
  "ERESPONSETIMEOUT",
  "ETRANSFERTIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

class RegistryUnavailableError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

class RegistryShutdownError extends Error {
  constructor(message, signal) {
    super(message);
    this.signal = signal;
  }
}

const retryableStatus = (status) => [404, 408, 429].includes(status) || (status >= 500 && status < 600);
function networkFailure(message, error) {
  const code =
    [error?.code, error?.cause?.code].find((value) => networkCodes.has(value)) ??
    (error?.name === "TimeoutError" ? "TimeoutError" : undefined);
  return new RegistryUnavailableError(`${message}${code ? ` (${code})` : ""}`, code !== undefined);
}

function parseArgs(args) {
  let packDir;
  const forwarded = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from-pack-dir" || arg.startsWith("--from-pack-dir=")) {
      if (packDir !== undefined) throw new Error("Duplicate --from-pack-dir");
      packDir = arg === "--from-pack-dir" ? args[++i] : arg.slice("--from-pack-dir=".length);
      if (!packDir || packDir.startsWith("-")) throw new Error("Missing --from-pack-dir value");
    } else {
      // CAC camel-cases the first dotted key and accepts negation before normalization.
      // Reject all equivalent overrides, even after --, rather than forwarding them.
      const key = arg.replace(/^-+/, "").replace(/^no-/, "").split(/[=.]/u)[0];
      if (arg.startsWith("-") && key.replace(/([a-z])-([a-z])/g, (_, a, b) => a + b.toUpperCase()) === "fromPackDir") {
        throw new Error("Only one canonical --from-pack-dir is allowed");
      }
      forwarded.push(arg);
    }
  }
  if (!packDir) throw new Error("--from-pack-dir is required");
  return { packDir, forwarded };
}

function safeTarballPath(relative) {
  if (
    typeof relative !== "string" ||
    !relative.endsWith(".tgz") ||
    relative.includes("\\") ||
    relative.includes(":") ||
    relative.includes("\0") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Unsafe tarball path");
  }
  return relative;
}

function verifyRegistryIntegrity(bytes, integrity) {
  if (typeof integrity !== "string") throw new Error("Missing registry integrity");
  const tokens = integrity.trim().split(/\s+/u);
  const supported = ["sha512", "sha384", "sha256", "sha1"];
  // SRI selects the strongest supported algorithm, not a weaker matching alternative.
  const algorithm = supported.find((name) => tokens.some((token) => token.startsWith(`${name}-`)));
  if (!algorithm || !tokens.includes(`${algorithm}-${digest(bytes, algorithm)}`)) {
    throw new Error("Registry artifact integrity mismatch");
  }
}

export async function publishPackedPackages(
  args,
  {
    cwd = process.cwd(),
    run = runChild,
    fetch: fetchArtifact = globalThis.fetch,
    wait = delay,
    log = console.error,
    now = () => performance.now(),
  } = {},
) {
  const { packDir, forwarded } = parseArgs(args);
  const artifactDir = await realpath(path.resolve(cwd, packDir));
  const document = JSON.parse(await readFile(path.join(artifactDir, "publish-plan.json"), "utf8"));
  if (
    document?.version !== 1 ||
    !Array.isArray(document.plan) ||
    document.plan.some((chunk) => !Array.isArray(chunk) || chunk.length === 0)
  ) {
    throw new Error("Invalid version 1 publish plan");
  }
  const packages = await getPackages(cwd);
  const manifests = new Map(packages.packages.map((pkg) => [pkg.packageJson.name, pkg.packageJson]));
  const releases = new Map();
  const artifacts = new Map();
  const paths = new Set();
  // Preflight every local artifact before the first native publish invocation.
  for (const release of document.plan.flat()) {
    const manifest = manifests.get(release?.name);
    if (
      !manifest ||
      typeof release.version !== "string" ||
      !semver.valid(release.version) ||
      manifest.version !== release.version ||
      releases.has(release.name) ||
      !["publish", "tag-only"].includes(release.kind)
    )
      throw new Error("Invalid release entry or workspace version");
    releases.set(release.name, release);
    if (
      release.kind === "publish" &&
      (manifest.private ||
        !["public", "restricted"].includes(release.access) ||
        typeof release.tag !== "string" ||
        !release.tag ||
        !release.tarball)
    ) {
      throw new Error("Invalid publish release");
    }
    if (!release.tarball) continue;
    const relative = safeTarballPath(release.tarball.path);
    if (paths.has(relative)) throw new Error("Duplicate tarball path");
    paths.add(relative);
    const absolute = await realpath(path.join(artifactDir, relative));
    if (!absolute.startsWith(`${artifactDir}${path.sep}`)) throw new Error("Unsafe tarball path");
    const bytes = await readFile(absolute);
    if (release.tarball.integrity !== `sha256-${digest(bytes, "sha256")}`)
      throw new Error("Local artifact integrity mismatch");
    artifacts.set(release.name, bytes);
  }
  const dependencies = new Map([...releases.keys()].map((name) => [name, new Set()]));
  // Match getPublishPlan's runtime graph, including normalized workspace paths and field precedence.
  const dependents = getDependentsGraph(packages, {
    ignoreDevDependencies: true,
    bumpVersionsWithWorkspaceProtocolOnly: false,
  });
  for (const [dependency, names] of dependents) {
    for (const name of names) {
      if (!dependencies.has(name)) continue;
      // A root reference cannot be verified as a publishable workspace artifact.
      if (!manifests.has(dependency)) throw new Error("Unsupported root runtime dependency");
      dependencies.get(name).add(dependency);
    }
  }
  const remaining = new Map(releases);
  const chunks = [];
  while (remaining.size) {
    const chunk = [...remaining.values()].filter((release) =>
      [...dependencies.get(release.name)].every((name) => !remaining.has(name)),
    );
    if (!chunk.length) throw new Error("Cyclic runtime dependencies in publish plan");
    chunks.push(chunk);
    for (const release of chunk) remaining.delete(release.name);
  }
  async function verifyArtifact(name, readiness) {
    const manifest = manifests.get(name);
    const exact = `${name}@${manifest.version}`;
    const { signal, check } = readiness;
    readiness.operation = "query metadata";
    check();
    let result;
    try {
      result = await run("npm", ["view", exact, "--json"], { cwd, capture: true, signal });
    } catch (error) {
      throw networkFailure(`Registry metadata unavailable: ${exact} (subprocess failed)`, error);
    }
    if (result.code !== 0) {
      let code;
      try {
        code = JSON.parse(result.stdout)?.error?.code;
      } catch {
        // Unknown npm failures stop without printing potentially credential-bearing output.
      }
      const status = typeof code === "string" && /^E\d{3}$/u.test(code) ? Number(code.slice(1)) : undefined;
      const retryable = retryableStatus(status) || networkCodes.has(code);
      const knownCode = retryable || ["E401", "E403", "ENEEDAUTH"].includes(code) ? `, ${code}` : "";
      throw new RegistryUnavailableError(
        `Registry metadata unavailable: ${exact} (npm exit ${result.code}${knownCode})`,
        retryable,
      );
    }
    check();
    let metadata;
    try {
      metadata = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Invalid registry metadata: ${exact}`);
    }
    if (
      metadata?.name !== name ||
      metadata.version !== manifest.version ||
      typeof metadata.dist?.tarball !== "string" ||
      !metadata.dist.integrity
    ) {
      throw new Error(`Invalid registry metadata: ${exact}`);
    }
    let url;
    try {
      url = new URL(metadata.dist.tarball);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid protocol");
    } catch {
      throw new Error(`Invalid registry artifact URL: ${exact}`);
    }
    let response;
    try {
      readiness.operation = "download tarball";
      check();
      try {
        response = await fetchArtifact(url, { redirect: "error", signal });
      } catch (error) {
        throw networkFailure(`Registry artifact unavailable: ${exact}`, error);
      }
      if (!response.ok) {
        throw new RegistryUnavailableError(
          `Registry artifact unavailable: ${exact} (${response.status})`,
          retryableStatus(response.status),
        );
      }
      check();
      readiness.operation = "read tarball body";
      let bytes;
      try {
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw networkFailure(`Registry artifact unavailable: ${exact}`, error);
      }
      check();
      verifyRegistryIntegrity(bytes, metadata.dist.integrity);
      const release = releases.get(name);
      if (artifacts.has(name) && release.tarball.integrity !== `sha256-${digest(bytes, "sha256")}`) {
        throw new Error(`Registry artifact differs from packed artifact: ${exact}`);
      }
    } finally {
      // Release unused bodies, including responses that arrived after the deadline.
      if (response && !response.bodyUsed) await response.body?.cancel().catch(() => {});
    }
  }
  async function verifyAvailable(name) {
    const exact = `${name}@${manifests.get(name).version}`;
    const started = now();
    const controller = new AbortController();
    const timeoutReason = new DOMException("Registry readiness deadline exceeded", "TimeoutError");
    const timer = setTimeout(() => controller.abort(timeoutReason), readinessTimeout);
    let attempt = 0;
    let lastFailure;
    let shutdownSignal;
    const interrupt = (signal) => {
      shutdownSignal ??= signal;
      controller.abort(new DOMException("Registry readiness cancelled", "AbortError"));
    };
    const onInterrupt = () => interrupt("SIGINT");
    const onTerminate = () => interrupt("SIGTERM");
    const remaining = () => Math.max(0, readinessTimeout - (now() - started));
    const context = () =>
      `operation ${readiness.operation}; attempt ${attempt}; elapsed ${Math.ceil(now() - started)} ms; remaining ${Math.ceil(remaining())} ms`;
    const readiness = {
      signal: controller.signal,
      operation: "query metadata",
      check() {
        if (shutdownSignal) {
          throw new RegistryShutdownError(
            `Registry readiness cancelled: ${exact}; signal ${shutdownSignal}; ${context()}`,
            shutdownSignal,
          );
        }
        if (!controller.signal.aborted && remaining() > 0) return;
        controller.abort(timeoutReason);
        throw new Error(
          `Registry readiness deadline exceeded: ${exact}; ${context()}${lastFailure ? `; last failure: ${lastFailure.message}` : ""}`,
        );
      },
    };
    // Only registry verification owns detached children; native publication keeps normal signal handling.
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    try {
      while (true) {
        readiness.check();
        attempt++;
        try {
          await verifyArtifact(name, readiness);
          readiness.check();
          return;
        } catch (error) {
          if (error instanceof RegistryUnavailableError) lastFailure = error;
          readiness.check();
          if (!(error instanceof RegistryUnavailableError)) throw error;
          const message = `${error.message}; ${context()}`;
          if (!error.retryable) throw new Error(message);
          const ms = Math.min(availabilityDelay, remaining());
          log(`[registry] ${message}; retrying in ${Math.ceil(ms)} ms`);
          readiness.operation = "retry wait";
          readiness.check();
          try {
            await wait(Math.min(ms, remaining()), undefined, { signal: controller.signal });
          } catch {
            readiness.check();
            throw new Error(`Registry retry wait failed: ${exact}; ${context()}`);
          }
          readiness.check();
        }
      }
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      clearTimeout(timer);
      controller.abort();
    }
  }
  const staging = await mkdtemp(path.join(os.tmpdir(), "changeset-guard-"));
  try {
    for (const [index, chunk] of chunks.entries()) {
      const required = new Set(chunk.flatMap((release) => [...dependencies.get(release.name)]));
      for (const name of required) await verifyAvailable(name);
      const directory = path.join(staging, String(index));
      await mkdir(directory);
      for (const release of chunk) {
        if (!artifacts.has(release.name)) continue;
        const target = path.join(directory, release.tarball.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, artifacts.get(release.name));
      }
      await writeFile(path.join(directory, "publish-plan.json"), JSON.stringify({ version: 1, plan: [chunk] }));
      // Native CLI retains npm provenance, git-tag creation, and append-only CHANGESETS_OUTPUT events.
      // Put packed mode before forwarded arguments so a trailing -- cannot hide the guard's path.
      const result = await run(process.execPath, [cli, "publish", "--from-pack-dir", directory, ...forwarded], { cwd });
      if (result.code !== 0) throw new Error(`Native Changesets publish failed (${result.code})`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  publishPackedPackages(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    // Re-raise only after query closure and staging cleanup, preserving shell signal status.
    if (error instanceof RegistryShutdownError) process.kill(process.pid, error.signal);
    else process.exitCode = 1;
  });
}
