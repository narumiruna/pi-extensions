import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { posixJoin } from "../../paths.js";
import type { Snapshot, SnapshotFile } from "../../snapshot/snapshot-types.js";
import { stateDir } from "../../state/state-directory.js";
import { syncErrorGuidance } from "../../sync/sync-error-guidance.js";
import type { ResolvedGitBackend } from "../backend-types.js";
import {
  type BackendDiagnostic,
  type ExpectedRemoteHead,
  type PublishSnapshotOptions,
  type PublishSnapshotResult,
  type RemoteHead,
  type RemoteHistoryEntry,
  type SyncBackend,
  SyncBackendConflictError,
  SyncBackendPublicationOutcomeUnknownError,
} from "../sync-backend.js";
import {
  normalizeGitBranch,
  normalizeGitDirectory,
  normalizeGitRemote,
  normalizeGitRemoteIdentity,
  validateGitNamespace,
} from "./git-config.js";
import { GitCommandError, readGitBlobs, runGit } from "./git-runner.js";
import {
  GIT_MANIFEST_VERSION,
  type GitManifest,
  MAX_GIT_MANIFEST_BYTES,
  MAX_GIT_TREE_OUTPUT_BYTES,
  type PreparedGitFile,
  parseGitTree,
  prepareGitSnapshot,
  requireGitManifest,
  validateGitPublicationTree,
  validateGitSnapshot,
} from "./git-storage.js";

const COMMAND_TIMEOUT_MS = 30_000;
const POST_COMMIT_TIMEOUT_MS = 45_000;
const gitCacheMutationQueues = new Map<string, Promise<void>>();

export interface GitBackendOptions {
  cacheRoot?: string;
  allowLocalRemotes?: boolean;
  commandTimeoutMs?: number;
  postCommitTimeoutMs?: number;
  /** Deterministic fault injection used only by the local backend test suite. */
  afterPushForTest?: () => void | Promise<void>;
  afterLsRemoteForTest?: () => void | Promise<void>;
  afterPayloadWriteForTest?: () => void | Promise<void>;
}

export class GitSyncBackend implements SyncBackend {
  readonly identity: string;
  readonly destination: string;
  readonly capability = "lease-protected" as const;
  private readonly cacheRoot: string;
  private readonly cacheDir: string;
  private readonly allowLocalRemotes: boolean;
  private readonly commandTimeoutMs: number;
  private readonly postCommitTimeoutMs: number;
  private readonly afterPushForTest?: () => void | Promise<void>;
  private readonly afterLsRemoteForTest?: () => void | Promise<void>;
  private readonly afterPayloadWriteForTest?: () => void | Promise<void>;
  private cacheReady?: Promise<void>;

  constructor(
    private readonly config: ResolvedGitBackend,
    options: GitBackendOptions = {},
  ) {
    assertGitDestination(config);
    this.allowLocalRemotes = options.allowLocalRemotes === true;
    if (!this.allowLocalRemotes) assertProductionRemote(config.profile.remote);
    this.identity = gitBackendIdentity(config);
    this.destination = gitDestination(config);
    this.cacheRoot = path.resolve(options.cacheRoot ?? path.join(stateDir(), "git"));
    this.cacheDir = path.join(this.cacheRoot, this.identity.slice("git:".length), "repository.git");
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.postCommitTimeoutMs = options.postCommitTimeoutMs ?? POST_COMMIT_TIMEOUT_MS;
    this.afterPushForTest = options.afterPushForTest;
    this.afterLsRemoteForTest = options.afterLsRemoteForTest;
    this.afterPayloadWriteForTest = options.afterPayloadWriteForTest;
  }

  sameRevision(left: string, right: string) {
    return decodeRevision(left, this.identity) === decodeRevision(right, this.identity);
  }

  async readHead(signal?: AbortSignal): Promise<RemoteHead | undefined> {
    const sha = await this.fetchRemoteHead(signal);
    if (!sha) return undefined;
    const { manifest } = await this.readPublication(sha, signal);
    return remoteHead(sha, manifest, this.identity);
  }

  async readSnapshot(reference: string, signal?: AbortSignal): Promise<Snapshot> {
    const head = await this.fetchRemoteHead(signal);
    if (!head) throw new Error(`Git snapshot publication was not found: ${reference}`);
    const commit = await this.resolveSnapshotReference(reference, head, signal);
    try {
      await this.git(["cat-file", "-e", `${commit}^{commit}`], { signal });
      await this.git(["merge-base", "--is-ancestor", commit, head], { signal });
    } catch (error) {
      throw new Error(`Git snapshot publication was not found: ${reference}`, { cause: error });
    }
    const { manifest, payloadEntries } = await this.readPublication(commit, signal);
    let blobs: Buffer[];
    try {
      blobs = await readGitBlobs(
        payloadEntries.map((entry) => entry.object),
        {
          gitDir: this.cacheDir,
          signal,
          timeoutMs: this.commandTimeoutMs,
          allowFileProtocol: this.allowLocalRemotes,
          maxOutputBytes: manifest.files.reduce((total, file) => total + file.size, 0),
        },
      );
    } catch (error) {
      if (error instanceof Error && /exceeds/u.test(error.message)) {
        throw new Error("Git snapshot file content exceeds its manifest size.", { cause: error });
      }
      throw this.redactedError(error);
    }
    throwIfAborted(signal);
    const files: SnapshotFile[] = manifest.files.map((file, index) => {
      const content = blobs[index];
      if (!content || content.byteLength !== file.size || sha256(content) !== file.sha256) {
        throw new Error(`Git snapshot file checksum or size mismatch: ${file.path}`);
      }
      return { path: file.path, contentBase64: content.toString("base64"), sha256: file.sha256 };
    });
    const snapshot: Snapshot = {
      version: manifest.snapshotVersion,
      id: manifest.snapshotId,
      createdAt: manifest.createdAt,
      machine: manifest.machine,
      profile: manifest.profile,
      ...(manifest.snapshotSyncSessions === undefined ? {} : { syncSessions: manifest.snapshotSyncSessions }),
      ...(manifest.selection === undefined ? {} : { selection: manifest.selection }),
      files,
    };
    validateGitSnapshot(snapshot, manifest, this.config.destination.namespace);
    return snapshot;
  }

  async publishSnapshot(
    snapshot: Snapshot,
    expected: ExpectedRemoteHead,
    options: PublishSnapshotOptions = {},
  ): Promise<PublishSnapshotResult> {
    throwIfAborted(options.signal);
    const files = prepareGitSnapshot(snapshot, this.config.destination.namespace);
    const observed = await this.fetchRemoteHead(options.signal);
    if (!matchesExpected(observed, expected, this.identity)) {
      throw new SyncBackendConflictError(
        "Git remote changed while preparing publication. Run /sync status and retry.",
        { currentHead: observed ? await this.headForSha(observed, options.signal) : undefined },
      );
    }
    throwIfAborted(options.signal);
    const manifest: GitManifest = {
      version: GIT_MANIFEST_VERSION,
      snapshotVersion: snapshot.version,
      snapshotId: snapshot.id,
      createdAt: snapshot.createdAt,
      machine: snapshot.machine,
      profile: snapshot.profile,
      syncSessions: snapshot.syncSessions === true || snapshot.files.some((file) => file.path.startsWith("sessions/")),
      ...(snapshot.syncSessions === undefined ? {} : { snapshotSyncSessions: snapshot.syncSessions }),
      ...(snapshot.selection === undefined ? {} : { selection: snapshot.selection }),
      files: files.map(({ path: filePath, sha256: fileSha, size }) => ({
        path: filePath,
        sha256: fileSha,
        size,
      })),
    };
    let candidate: string;
    try {
      candidate = await this.createCommit(snapshot, files, manifest, observed, options.signal);
    } catch (error) {
      throw this.redactedError(error);
    }
    throwIfAborted(options.signal);
    options.onCommit?.();

    const ref = this.remoteRef();
    const lease = `--force-with-lease=${ref}:${observed ?? ""}`;
    let pushError: unknown;
    try {
      await this.git(["push", "--porcelain", "--no-verify", lease, this.config.profile.remote, `${candidate}:${ref}`], {
        timeoutMs: this.postCommitTimeoutMs,
      });
      await this.afterPushForTest?.();
    } catch (error) {
      pushError = error;
    }

    let current: string | undefined;
    try {
      current = await this.fetchRemoteHead(AbortSignal.timeout(this.postCommitTimeoutMs));
    } catch (error) {
      throw new SyncBackendPublicationOutcomeUnknownError(
        `Git publication outcome is unknown: ${this.safeError(pushError ?? error)}`,
        { cause: pushError ?? error },
      );
    }
    if (current !== candidate) {
      if (pushError && current === observed) {
        throw new Error(`Git publication failed without updating the owned branch: ${this.safeError(pushError)}`, {
          cause: pushError,
        });
      }
      throw new SyncBackendConflictError(
        pushError
          ? `Git publication lease was rejected: ${this.safeError(pushError)}`
          : "Git remote changed immediately after publication.",
        {
          phase: "after-commit",
          currentHead: current ? await this.headForSha(current) : undefined,
          candidateMayHaveBeenActive: true,
          cause: pushError instanceof Error ? pushError : undefined,
        },
      );
    }
    const head = await this.headForSha(candidate);
    return { head, warnings: [] };
  }

  async listHistory(signal?: AbortSignal): Promise<RemoteHistoryEntry[]> {
    const sha = await this.fetchRemoteHead(signal);
    if (!sha) return [];
    const result = await this.git(["rev-list", "--first-parent", "--reverse", "--max-count=100", sha], { signal });
    const commits = result.stdout.toString("utf8").trim().split("\n").filter(Boolean);
    const entries: RemoteHistoryEntry[] = [];
    for (const commit of commits) {
      const { manifest } = await this.readPublication(commit, signal);
      entries.push({
        snapshotRef: commit,
        snapshotId: manifest.snapshotId,
        createdAt: manifest.createdAt,
        machine: manifest.machine,
        syncSessions: manifest.syncSessions,
      });
    }
    return entries;
  }

  async diagnose(signal?: AbortSignal): Promise<BackendDiagnostic[]> {
    const diagnostics: BackendDiagnostic[] = [
      {
        key: "git-scope",
        level: "info",
        message: "git check scope: read remote snapshots and inspect the local cache. Write access is not tested.",
      },
    ];
    try {
      const version = await runGit(["--version"], {
        signal,
        timeoutMs: this.commandTimeoutMs,
      });
      const versionText = version.stdout.toString("utf8").trim();
      const supported = isSupportedGitVersion(versionText);
      diagnostics.push({
        key: "git-version",
        level: supported ? "info" : "error",
        message: supported
          ? versionText
          : `${versionText || "unknown Git version"}; pi-sync requires Git 2.30 or newer`,
      });
    } catch (error) {
      return [
        {
          key: "git-version",
          level: "error",
          message: syncErrorGuidance(new Error(this.safeError(error))),
        },
      ];
    }
    try {
      const head = await this.readHead(signal);
      if (head) await this.readSnapshot(head.snapshotRef, signal);
      diagnostics.push({
        key: "git-remote",
        level: "info",
        message: head
          ? `git remote: reachable; owned branch ${this.config.destination.branch} is valid`
          : `git remote: reachable; owned branch ${this.config.destination.branch} is not created yet`,
      });
      diagnostics.push({
        key: "git-cache",
        level: "info",
        message: "git cache: private bare repository is healthy",
      });
    } catch (error) {
      diagnostics.push({
        key: "git-remote",
        level: "error",
        message: `git remote: ${syncErrorGuidance(new Error(this.safeError(error)))}`,
      });
    }
    return diagnostics;
  }

  private async resolveSnapshotReference(reference: string, head: string, signal?: AbortSignal) {
    if (isCommitSha(reference) || /^[0-9a-f]{64}$/u.test(reference)) {
      requireCommitSha(reference);
      return reference;
    }
    if (!reference || reference.length > 512 || !/^[A-Za-z0-9._-]+$/u.test(reference)) {
      throw new Error("Invalid Git publication reference.");
    }
    const result = await this.git(["rev-list", "--first-parent", "--max-count=100", head], {
      signal,
    });
    const commits = result.stdout.toString("utf8").trim().split("\n").filter(Boolean);
    const matches: string[] = [];
    for (const commit of commits) {
      const { manifest } = await this.readPublication(commit, signal);
      if (manifest.snapshotId === reference) matches.push(commit);
    }
    if (matches.length === 0) {
      throw new Error(`Git snapshot publication was not found: ${reference}`);
    }
    if (matches.length > 1) {
      throw new Error(`Git snapshot id is ambiguous; use a commit reference from /sync history: ${reference}`);
    }
    return matches[0] as string;
  }

  private async headForSha(sha: string, signal?: AbortSignal) {
    const { manifest } = await this.readPublication(sha, signal);
    return remoteHead(sha, manifest, this.identity);
  }

  private async fetchRemoteHead(signal?: AbortSignal) {
    await this.ensureCache(signal);
    const result = await this.git(["ls-remote", "--refs", this.config.profile.remote, this.remoteRef()], { signal });
    const line = result.stdout.toString("utf8").trim();
    if (!line) return undefined;
    const [sha, ref, ...extra] = line.split(/\s+/u);
    if (extra.length > 0 || ref !== this.remoteRef() || !sha) {
      throw new Error("Git remote returned a malformed owned-ref response.");
    }
    requireCommitSha(sha);
    await this.afterLsRemoteForTest?.();
    return withGitCacheMutation(
      this.cacheDir,
      async () => {
        const localRef = `refs/pisync/fetch/${process.pid}-${randomUUID()}`;
        try {
          await this.git(
            ["fetch", "--no-tags", "--force", this.config.profile.remote, `${this.remoteRef()}:${localRef}`],
            { signal },
          );
          const fetched = (await this.git(["rev-parse", "--verify", localRef], { signal })).stdout
            .toString("utf8")
            .trim();
          requireCommitSha(fetched);
          return fetched;
        } finally {
          await this.git(["update-ref", "-d", localRef], { timeoutMs: 5_000 }).catch(() => undefined);
        }
      },
      signal,
    );
  }

  private async readManifest(commit: string, signal?: AbortSignal): Promise<GitManifest> {
    requireCommitSha(commit);
    const bytes = await this.showFile(commit, this.manifestPath(), signal, MAX_GIT_MANIFEST_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error("Git publication manifest is malformed.", { cause: error });
    }
    return requireGitManifest(parsed);
  }

  private showFile(commit: string, filePath: string, signal?: AbortSignal, maxOutputBytes?: number) {
    return this.git(["show", `${commit}:${filePath}`], { signal, maxOutputBytes }).then((result) => result.stdout);
  }

  private async createCommit(
    snapshot: Snapshot,
    files: PreparedGitFile[],
    manifest: GitManifest,
    parent: string | undefined,
    signal?: AbortSignal,
  ) {
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    if (manifestBytes.byteLength > MAX_GIT_MANIFEST_BYTES) {
      throw new Error(`Git publication manifest exceeds the ${MAX_GIT_MANIFEST_BYTES}-byte limit.`);
    }
    await this.ensureCache(signal);
    const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(this.cacheDir), ".index-"));
    const indexPath = path.join(temporaryDirectory, "index");
    const payloadDirectory = path.join(temporaryDirectory, "payloads");
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      await fs.mkdir(payloadDirectory, { mode: 0o700 });
      const uniqueFiles = [...new Map(files.map((file) => [file.sha256, file])).values()].sort((left, right) =>
        left.sha256.localeCompare(right.sha256),
      );
      for (const file of uniqueFiles) {
        throwIfAborted(signal);
        await fs.writeFile(path.join(payloadDirectory, file.sha256), file.content, {
          flag: "wx",
          mode: 0o600,
        });
      }
      await this.afterPayloadWriteForTest?.();
      throwIfAborted(signal);
      const hashed = await this.git(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
        cwd: payloadDirectory,
        input: uniqueFiles.map((file) => file.sha256).join("\n") + (uniqueFiles.length ? "\n" : ""),
        signal,
        maxOutputBytes: Math.max(1024, uniqueFiles.length * 64),
      });
      const objectIds = hashed.stdout.toString("utf8").trim().split("\n").filter(Boolean);
      if (objectIds.length !== uniqueFiles.length || objectIds.some((id) => !isCommitSha(id))) {
        throw new Error("Git hash-object returned a malformed payload response.");
      }
      const objectsBySha256 = new Map(uniqueFiles.map((file, index) => [file.sha256, objectIds[index] as string]));
      const manifestBlob = (await this.git(["hash-object", "-w", "--stdin"], { input: manifestBytes, signal })).stdout
        .toString("utf8")
        .trim();
      if (!isCommitSha(manifestBlob)) throw new Error("Git returned an invalid manifest blob id.");
      await this.git(["read-tree", "--empty"], { env, signal });
      const indexLines = [
        `100644 ${manifestBlob}\t${this.manifestPath()}`,
        ...files.map((file) => {
          const object = objectsBySha256.get(file.sha256);
          if (!object) throw new Error("Git payload object is missing after hashing.");
          return `100644 ${object}\t${this.filePath(file.path)}`;
        }),
      ];
      await this.git(["update-index", "-z", "--index-info"], {
        env,
        signal,
        input: Buffer.from(`${indexLines.join("\0")}\0`, "utf8"),
      });
      const tree = (await this.git(["write-tree"], { env, signal })).stdout.toString("utf8").trim();
      const date = Number.isNaN(Date.parse(snapshot.createdAt)) ? new Date().toISOString() : snapshot.createdAt;
      const commit = await this.git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], {
        signal,
        input: `pi-sync snapshot ${snapshot.id}\n`,
        env: {
          GIT_AUTHOR_NAME: "pi-sync",
          GIT_AUTHOR_EMAIL: "pi-sync@localhost",
          GIT_COMMITTER_NAME: "pi-sync",
          GIT_COMMITTER_EMAIL: "pi-sync@localhost",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
      const sha = commit.stdout.toString("utf8").trim();
      requireCommitSha(sha);
      return sha;
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private ensureCache(signal?: AbortSignal) {
    if (!this.cacheReady) {
      const operation = withGitCacheMutation(this.cacheDir, () => this.initializeCache(signal), signal);
      const wrapped = operation.catch((error) => {
        if (this.cacheReady === wrapped) this.cacheReady = undefined;
        throw this.redactedError(error);
      });
      this.cacheReady = wrapped;
    }
    return this.cacheReady;
  }

  private async initializeCache(signal?: AbortSignal) {
    const version = await runGit(["--version"], {
      signal,
      timeoutMs: this.commandTimeoutMs,
    });
    const versionText = version.stdout.toString("utf8").trim();
    if (!isSupportedGitVersion(versionText)) {
      throw new Error(`${versionText || "Unknown Git version"}; pi-sync requires Git 2.30 or newer.`);
    }
    const parent = path.dirname(this.cacheDir);
    const cacheParent = path.dirname(this.cacheRoot);
    await assertNotSymlink(cacheParent, "Git cache parent");
    await assertNotSymlink(this.cacheRoot, "Git cache root");
    await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    await assertNotSymlink(cacheParent, "Git cache parent");
    await assertNotSymlink(this.cacheRoot, "Git cache root");
    await assertNotSymlink(parent, "Git cache identity directory");
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await assertNotSymlink(parent, "Git cache identity directory");
    let recreate = false;
    try {
      const stat = await fs.lstat(this.cacheDir);
      if (stat.isSymbolicLink()) throw new Error("Refusing symlinked Git cache.");
      if (!stat.isDirectory()) recreate = true;
      else {
        try {
          recreate = !(await this.cacheUsesSha1(signal));
        } catch {
          throwIfAborted(signal);
          recreate = true;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    throwIfAborted(signal);
    if (recreate) await fs.rm(this.cacheDir, { recursive: true, force: true });
    try {
      await fs.access(this.cacheDir);
    } catch {
      try {
        await runGit(["init", "--bare", "--object-format=sha1", this.cacheDir], {
          signal,
          timeoutMs: this.commandTimeoutMs,
          allowFileProtocol: this.allowLocalRemotes,
        });
      } catch (initError) {
        const concurrent = await this.cacheUsesSha1(signal).catch(() => false);
        if (!concurrent) throw initError;
      }
    }
    if (process.platform !== "win32") await fs.chmod(parent, 0o700);
  }

  private async cacheUsesSha1(signal?: AbortSignal) {
    const result = await this.git(["rev-parse", "--is-bare-repository", "--show-object-format"], {
      signal,
    });
    return result.stdout.toString("utf8").trim() === "true\nsha1";
  }

  private git(
    args: string[],
    options: {
      cwd?: string;
      input?: Buffer | string;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs?: number;
      maxOutputBytes?: number;
    } = {},
  ) {
    return runGit(args, {
      gitDir: this.cacheDir,
      allowFileProtocol: this.allowLocalRemotes,
      timeoutMs: options.timeoutMs ?? this.commandTimeoutMs,
      ...options,
    }).catch((error) => {
      throw this.redactedError(error);
    });
  }

  private remoteRef() {
    return `refs/heads/${this.config.destination.branch}`;
  }

  private publicationPath() {
    return this.config.destination.directory === "./" ? "" : this.config.destination.directory;
  }

  private manifestPath() {
    return posixJoin(this.publicationPath(), "manifest.json");
  }

  private filePath(filePath: string) {
    return posixJoin(this.publicationPath(), "files", filePath);
  }

  private async readPublication(commit: string, signal?: AbortSignal) {
    const manifest = await this.readManifest(commit, signal);
    const entries = await this.readPublicationTree(commit, signal);
    const payloadEntries = validateGitPublicationTree(entries, manifest, this.manifestPath(), (filePath) =>
      this.filePath(filePath),
    );
    return { manifest, payloadEntries };
  }

  private async readPublicationTree(commit: string, signal?: AbortSignal) {
    const result = await this.git(["ls-tree", "-r", "-z", commit], {
      signal,
      maxOutputBytes: MAX_GIT_TREE_OUTPUT_BYTES,
    });
    return parseGitTree(result.stdout);
  }

  private redactedError(error: unknown) {
    if (error instanceof Error && error.name === "AbortError") return error;
    return new Error(this.safeError(error));
  }

  private safeError(error: unknown) {
    const raw =
      error instanceof GitCommandError
        ? error.stderr || error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return redactGitError(raw, this.config.profile.remote, this.cacheDir);
  }
}

export function gitBackendIdentity(config: ResolvedGitBackend) {
  let remoteIdentity: string;
  try {
    remoteIdentity = normalizeGitRemoteIdentity(config.profile.remote);
  } catch {
    remoteIdentity = config.profile.remote;
  }
  const canonical = JSON.stringify([remoteIdentity, config.destination.branch, config.destination.directory]);
  return `git:${sha256(Buffer.from(canonical))}`;
}

function gitDestination(config: ResolvedGitBackend) {
  let host = "Git remote";
  const remote = config.profile.remote;
  if (remote.includes("://")) {
    try {
      host = new URL(remote).host;
    } catch {
      host = "Git remote";
    }
  } else {
    const match = /^(?:[^@]+@)?(?<host>\[[^\]]+\]|[^:]+):/u.exec(remote);
    if (match?.groups?.host) host = match.groups.host;
  }
  return `${host} · ${config.destination.branch}:${config.destination.directory}`;
}

function remoteHead(sha: string, manifest: GitManifest, identity: string): RemoteHead {
  return {
    snapshotRef: sha,
    snapshotId: manifest.snapshotId,
    revision: `${identity}:${sha}`,
    createdAt: manifest.createdAt,
    machine: manifest.machine,
    syncSessions: manifest.syncSessions,
    ...(manifest.selection === undefined ? {} : { selection: manifest.selection }),
  };
}

function matchesExpected(current: string | undefined, expected: ExpectedRemoteHead, identity: string) {
  if (expected.kind === "missing") return current === undefined;
  try {
    return current === decodeRevision(expected.revision, identity);
  } catch {
    return false;
  }
}

function decodeRevision(revision: string, identity: string) {
  const prefix = `${identity}:`;
  const sha = revision.startsWith(prefix) ? revision.slice(prefix.length) : "";
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("Invalid Git remote revision.");
  return sha;
}

function isCommitSha(value: string) {
  return /^[0-9a-f]{40}$/u.test(value);
}

function requireCommitSha(value: string) {
  if (/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("Unsupported Git SHA-256 repository; pi-sync currently requires SHA-1 refs.");
  }
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error("Invalid Git publication reference.");
}

export function isSupportedGitVersion(value: string) {
  const match = /git version (\d+)\.(\d+)/u.exec(value);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 30);
}

function assertGitDestination(config: ResolvedGitBackend) {
  try {
    if (
      normalizeGitBranch(config.destination.branch) !== config.destination.branch ||
      normalizeGitDirectory(config.destination.directory) !== config.destination.directory
    ) {
      throw new Error("Git storage location is not normalized.");
    }
    validateGitNamespace(config.destination.namespace);
  } catch (error) {
    throw new Error("Invalid Git storage location.", { cause: error });
  }
}

function assertProductionRemote(remote: string) {
  let normalized: string | undefined;
  try {
    normalized = normalizeGitRemote(remote);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid Git remote.", {
      cause: error,
    });
  }
  if (!normalized || normalized !== remote) throw new Error("Invalid or non-normalized Git remote.");
}

async function withGitCacheMutation<T>(cacheDir: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = gitCacheMutationQueues.get(cacheDir) ?? Promise.resolve();
  let started = false;
  const operation = previous
    .catch(() => undefined)
    .then(() => {
      throwIfAborted(signal);
      started = true;
      return run();
    });
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  gitCacheMutationQueues.set(cacheDir, tail);
  void tail.then(() => {
    if (gitCacheMutationQueues.get(cacheDir) === tail) gitCacheMutationQueues.delete(cacheDir);
  });
  if (!signal) return operation;
  throwIfAborted(signal);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([operation, aborted]);
  } catch (error) {
    // A queued job can cancel immediately, but a running job owns a child/cache
    // mutation. Drain its bounded cleanup before releasing outer sync guards.
    if (started) await tail;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function assertNotSymlink(target: string, label: string) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked ${label}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function redactGitError(value: string, remote: string, cacheDir: string) {
  return (
    value
      .replaceAll(remote, "<git-remote>")
      .replaceAll(cacheDir, "<git-cache>")
      .replace(/https:\/\/[^/@\s]+@/gu, "https://<credentials>@")
      .replace(/\b(password|token|authorization)=\S+/giu, "$1=<redacted>")
      .replace(/\bBearer\s+\S+/giu, "Bearer <redacted>")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize untrusted process output.
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .trim()
      .slice(0, 4096)
  );
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortReason(signal);
}
