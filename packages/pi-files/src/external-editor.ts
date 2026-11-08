import { type ChildProcess, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentDir, SettingsManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

export interface ExternalEditorProcess {
  readonly killed: boolean;
  kill(): boolean;
  once(event: "close", listener: (code: number | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type SpawnExternalEditorProcess = (command: string, args: readonly string[]) => ExternalEditorProcess;

export interface EditProjectFileInExternalEditorOptions {
  root: string;
  projectPath: string;
  tui: TUI;
  projectTrusted: boolean;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  agentDir?: string;
  command?: string;
  spawnProcess?: SpawnExternalEditorProcess;
}

export async function editProjectFileInExternalEditor(options: EditProjectFileInExternalEditorOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const target = await resolveEditableProjectFile(options.root, options.projectPath, options.signal);
  options.signal?.throwIfAborted();
  const command =
    options.command ??
    SettingsManager.create(options.root, options.agentDir ?? getAgentDir(), {
      projectTrusted: options.projectTrusted,
    }).getExternalEditorCommand();
  const [editor, ...editorArgs] = command.trim().split(/\s+/u);
  if (!editor) throw new Error("External editor command is empty");
  assertEditorTargetSafeForPlatform(target);

  await withFileMutationQueue(target, async () => {
    options.signal?.throwIfAborted();
    let stopped = false;
    try {
      options.tui.stop();
      stopped = true;
      process.stdout.write("Launching external editor. Pi will resume when the editor exits.\n");
      await runExternalEditorProcess(editor, [...editorArgs, target], options.signal, options.spawnProcess);
      options.signal?.throwIfAborted();
    } finally {
      if (stopped && !options.signal?.aborted && (options.isCurrent === undefined || options.isCurrent())) {
        options.tui.start();
        options.tui.requestRender(true);
      }
    }
  });
}

export async function resolveEditableProjectFile(
  root: string,
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!projectPath || isAbsolute(projectPath) || projectPath.includes("\0")) {
    throw new Error("File path is outside the project");
  }
  const canonicalRoot = await realpath(root);
  signal?.throwIfAborted();
  const candidate = resolve(canonicalRoot, projectPath);
  if (!isInside(canonicalRoot, candidate)) throw new Error("File path is outside the project");
  const candidateInfo = await lstat(candidate);
  signal?.throwIfAborted();
  if (candidateInfo.isSymbolicLink()) throw new Error(`${projectPath} is a symbolic link`);
  const canonicalFile = await realpath(candidate);
  signal?.throwIfAborted();
  if (!isInside(canonicalRoot, canonicalFile)) throw new Error("File path is outside the project");
  const info = await lstat(canonicalFile);
  signal?.throwIfAborted();
  if (!info.isFile()) throw new Error(`${projectPath} is not a regular file`);
  return canonicalFile;
}

async function runExternalEditorProcess(
  command: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  spawnProcess: SpawnExternalEditorProcess = defaultSpawnExternalEditorProcess,
): Promise<void> {
  signal?.throwIfAborted();
  const child = spawnProcess(command, args);
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    let aborted = signal?.aborted ?? false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolvePromise();
    };
    const abort = () => {
      aborted = true;
      if (!child.killed) child.kill();
    };
    child.once("error", (error) => finish(aborted ? abortError() : error));
    child.once("close", (code) => {
      if (aborted) {
        finish(abortError());
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`External editor exited with code ${code ?? "unknown"}`));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function assertEditorTargetSafeForPlatform(target: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && /[\r\n"&|<>^()%!]/u.test(target)) {
    throw new Error("File path contains characters unsafe for the Windows external-editor shell");
  }
}

function defaultSpawnExternalEditorProcess(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function abortError(): DOMException {
  return new DOMException("External editor cancelled", "AbortError");
}
