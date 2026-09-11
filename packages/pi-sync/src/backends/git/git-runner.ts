import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

export interface GitRunOptions {
  gitDir?: string;
  cwd?: string;
  input?: Buffer | string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowFileProtocol?: boolean;
}

export interface GitRunResult {
  stdout: Buffer;
  stderr: Buffer;
}

export class GitCommandError extends Error {
  readonly code = "GIT_COMMAND_FAILED";
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitCommandError";
  }
}

export async function runGit(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  throwIfAborted(options.signal);
  const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  const protocolArgs = [
    "-c",
    `core.hooksPath=${hooksPath}`,
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ssh.allow=always",
  ];
  if (options.allowFileProtocol) protocolArgs.push("-c", "protocol.file.allow=always");
  const commandArgs = [...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []), ...protocolArgs, ...args];
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("GIT_") &&
        key !== "PAGER" &&
        key !== "EDITOR" &&
        key !== "VISUAL" &&
        key !== "SSH_ASKPASS" &&
        key !== "SSH_ASKPASS_REQUIRE",
    ),
  );
  const allowedGitOverrides = new Set([
    "GIT_INDEX_FILE",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
  ]);
  const suppliedEnvironment = Object.fromEntries(
    Object.entries(options.env ?? {}).filter(([key]) => !key.startsWith("GIT_") || allowedGitOverrides.has(key)),
  );
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    ...suppliedEnvironment,
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    EDITOR: "true",
    VISUAL: "true",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
  };
  const child = spawn("git", commandArgs, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let total = 0;
  let settled = false;
  let terminationError: Error | undefined;
  let escalationTimer: NodeJS.Timeout | undefined;
  const limit = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;

  const terminate = (error: Error) => {
    if (settled || terminationError) return;
    terminationError = error;
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
      if (child.pid && process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => undefined);
        killer.unref();
      }
    }
    escalationTimer = setTimeout(() => {
      if (settled) return;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, 2_000);
  };
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    total += chunk.byteLength;
    if (total > limit) {
      terminate(new Error(`Git output exceeds the ${limit}-byte limit.`));
      return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input);
  const onAbort = () =>
    terminate(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new DOMException("The operation was aborted", "AbortError"),
    );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => terminate(new Error(`Git command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`)),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let result: GitRunResult;
  try {
    result = await new Promise<GitRunResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        settled = true;
        if (escalationTimer) clearTimeout(escalationTimer);
        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);
        if (terminationError) {
          reject(terminationError);
          return;
        }
        if (code !== 0) {
          const stderrText = stderrBuffer.toString("utf8").trim();
          reject(new GitCommandError(stderrText || `Git exited with status ${code ?? "unknown"}.`, code, stderrText));
          return;
        }
        resolve({ stdout: stdoutBuffer, stderr: stderrBuffer });
      });
    });
  } finally {
    clearTimeout(timer);
    if (escalationTimer) clearTimeout(escalationTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  return result;
}

export function parseGitBlobBatch(output: Buffer, expectedCount: number, maxContentBytes: number) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error("Invalid Git batch object count.");
  }
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0) {
    throw new Error("Invalid Git batch content limit.");
  }
  const blobs: Buffer[] = [];
  let offset = 0;
  let contentBytes = 0;
  for (let index = 0; index < expectedCount; index += 1) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error("Git cat-file batch response is truncated.");
    const header = output.subarray(offset, headerEnd).toString("utf8");
    if (header.endsWith(" missing")) throw new Error("Git cat-file batch object is missing.");
    const match = /^(?<object>[0-9a-f]{40}) blob (?<size>0|[1-9][0-9]*)$/u.exec(header);
    if (!match?.groups) throw new Error("Git cat-file batch response is malformed.");
    const size = Number(match.groups.size);
    if (!Number.isSafeInteger(size)) throw new Error("Git cat-file batch size is malformed.");
    contentBytes += size;
    if (contentBytes > maxContentBytes) {
      throw new Error(`Git cat-file batch content exceeds the ${maxContentBytes}-byte limit.`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length) throw new Error("Git cat-file batch response is truncated.");
    if (output[contentEnd] !== 0x0a) {
      throw new Error("Git cat-file batch response is malformed.");
    }
    blobs.push(Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== output.length) throw new Error("Git cat-file batch response has trailing data.");
  return blobs;
}

export async function readGitBlobs(
  objects: string[],
  options: Omit<GitRunOptions, "input" | "maxOutputBytes"> & { maxOutputBytes: number },
) {
  if (objects.length === 0) return [];
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0) {
    throw new Error("Invalid Git batch output limit.");
  }
  if (objects.some((object) => !/^[0-9a-f]{40}$/u.test(object))) {
    throw new Error("Invalid Git blob object id.");
  }
  const protocolOverhead = objects.length * 96;
  if (!Number.isSafeInteger(protocolOverhead + options.maxOutputBytes)) {
    throw new Error("Invalid Git batch output limit.");
  }
  const result = await runGit(["cat-file", "--batch"], {
    ...options,
    input: `${objects.join("\n")}\n`,
    maxOutputBytes: options.maxOutputBytes + protocolOverhead,
  });
  return parseGitBlobBatch(result.stdout, objects.length, options.maxOutputBytes);
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
