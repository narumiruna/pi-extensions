import { posix } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Bash, type IFileSystem } from "just-bash";
import { Type } from "typebox";
import { boundedText } from "./output.js";
import { virtualPath } from "./paths.js";
import { createVirtualRead } from "./read.js";
import { virtualRenderers } from "./renderers.js";
import type { Workspace } from "./workspace.js";

export const SHELL_COMMANDS = [
  "ls",
  "cat",
  "grep",
  "find",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "tee",
  "pwd",
  "echo",
  "true",
  "false",
  "sleep",
  "seq",
  "sed",
] as const;
export const SHELL_TIMEOUT_SECONDS = 30;
export const SHELL_LIMITS = {
  maxSourceBytes: 64 * 1024,
  maxCommandCount: 10_000,
  maxLoopIterations: 1000,
  maxOutputSize: 1024 * 1024,
  maxExecutionTimeMs: SHELL_TIMEOUT_SECONDS * 1000,
} as const;

function fileOperations(fs: IFileSystem, path: string) {
  // Pin operations to the virtual path. Pi may normalize Unicode spaces, file URLs, or Windows
  // paths internally; those host-oriented transformations must not select a different file.
  return {
    access: async () => {
      const stat = await fs.stat(path);
      if (!stat.isFile || stat.isSymbolicLink) throw new Error("Path is not a regular virtual file.");
    },
    readFile: async () => Buffer.from(await fs.readFileBuffer(path)),
    writeFile: async (_resolved: string, content: string) => fs.writeFile(path, content),
    mkdir: () => fs.mkdir(posix.dirname(path), { recursive: true }),
  };
}

export function createWorkspaceTools(resolveWorkspace: (ctx: ExtensionContext) => Workspace): ToolDefinition[] {
  function wrap<T extends Type.TSchema, D, S>(
    metadata: ToolDefinition<T, D, S>,
    create: (fs: IFileSystem, input: Parameters<ToolDefinition<T>["execute"]>[1]) => ToolDefinition<T, D, S>,
    normalize: (input: Parameters<ToolDefinition<T>["execute"]>[1]) => Parameters<ToolDefinition<T>["execute"]>[1],
  ): ToolDefinition<T, D, S> {
    return {
      ...metadata,
      ...virtualRenderers(metadata.name),
      async execute(id, input, signal, _onUpdate, ctx) {
        try {
          return await resolveWorkspace(ctx).run(signal, async (fs, operationSignal) => {
            const normalized = normalize(input);
            const result = await create(fs, normalized).execute(id, normalized, operationSignal, undefined, {
              ...ctx,
              cwd: "/",
            });
            return {
              ...result,
              content: result.content.map((item) =>
                item.type === "text" ? { ...item, text: boundedText(item.text) } : item,
              ),
            };
          });
        } catch (error) {
          throw new Error(boundedText(error instanceof Error ? error.message : String(error)));
        }
      },
    };
  }
  const files = [
    wrap(
      createVirtualRead({ access: async () => {}, readFile: async () => Buffer.alloc(0) }),
      (fs, input) => createVirtualRead(fileOperations(fs, input.path)),
      (input) => ({ ...input, path: virtualPath(input.path) }),
    ),
    wrap(
      createWriteToolDefinition("/"),
      (fs, input) => createWriteToolDefinition("/", { operations: fileOperations(fs, input.path) }),
      (input) => ({ ...input, path: virtualPath(input.path) }),
    ),
    wrap(
      createEditToolDefinition("/"),
      (fs, input) => createEditToolDefinition("/", { operations: fileOperations(fs, input.path) }),
      (input) => ({ ...input, path: virtualPath(input.path) }),
    ),
  ];
  const shellSchema = Type.Object({
    command: Type.String(),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds, greater than 0 and at most 30" })),
  });
  const shell: ToolDefinition<typeof shellSchema> = {
    name: "bash",
    label: "bash",
    description:
      "Run a restricted just-bash script in AgentFS, not a host shell. Supports virtual file commands, pipes, and redirection. Each call starts at / with a fresh environment. No network, subprocesses, Python, or JavaScript. Output is limited to 50 KB or 2,000 lines; excess output is discarded. Timeout defaults to 30 seconds and cannot exceed 30 seconds.",
    promptSnippet: "Run restricted shell commands in the AgentFS virtual workspace",
    parameters: shellSchema,
    outputSchema: Type.Object({ output: Type.String(), exit_code: Type.Number(), truncated: Type.Boolean() }),
    ...virtualRenderers("bash"),
    async execute(_id, { command, timeout = SHELL_TIMEOUT_SECONDS }, signal, _onUpdate, ctx) {
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > SHELL_TIMEOUT_SECONDS) {
        throw new Error("Timeout must be greater than 0 and at most 30 seconds.");
      }
      try {
        return await resolveWorkspace(ctx).run(signal, async (fs, operationSignal) => {
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(), Math.max(1, timeout * 1000));
          const combined = AbortSignal.any([operationSignal, deadline.signal]);
          try {
            const shell = new Bash({
              fs,
              cwd: "/",
              env: { HOME: "/", PATH: "/usr/bin:/bin" },
              commands: [...SHELL_COMMANDS],
              python: false,
              javascript: false,
              executionLimitProfile: "hardened",
              executionLimits: SHELL_LIMITS,
            });
            const result = await shell.exec(command, {
              signal: combined,
              cwd: "/",
              replaceEnv: true,
              env: { HOME: "/", PATH: "/usr/bin:/bin" },
            });
            if (combined.aborted) throw new Error("Command aborted");
            const raw = result.stdout + result.stderr;
            const output = boundedText(raw);
            if (result.exitCode !== 0)
              throw new Error(boundedText(`Command exited with code ${result.exitCode}\n${raw}`));
            return {
              content: [{ type: "text" as const, text: output || "(no output)" }],
              details: undefined,
              structuredContent: { output, exit_code: result.exitCode, truncated: output !== raw },
            };
          } catch (error) {
            if (deadline.signal.aborted) throw new Error(`Command timed out after ${timeout} seconds.`);
            if (operationSignal.aborted) throw new Error("Command aborted.");
            throw error;
          } finally {
            clearTimeout(timer);
          }
        });
      } catch (error) {
        throw new Error(boundedText(error instanceof Error ? error.message : String(error)));
      }
    },
  };
  // ToolDefinition is invariant in its schema/renderers. Pi validates each concrete schema before
  // execute; this heterogeneous registration list does not change any definition or implementation.
  return [...files, shell] as unknown as ToolDefinition[];
}
