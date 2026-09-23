import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { isWithin } from "./attachment-utils.js";
import {
  assertChildBootstrapCapacity,
  BROKER_CREDENTIAL_FD,
  CHILD_READINESS_FD,
  CHILD_READINESS_FD_ENV,
  childBootstrapEnvironment,
  MAX_READINESS_FRAME_BYTES,
  serializeChildBootstrap,
} from "./broker-credentials.js";
import { CHILD_COMMUNICATION_TOOL_NAMES } from "./child-communication-tools.js";
import { sanitizeTerminalText } from "./message-broker.js";
import { resolveTimeoutMs } from "./timeout.js";
import type { ChildControl, ChildRequest, ChildResult } from "./types.js";

export { resolveTimeoutMs };

const CORE_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_EVENT_LINE_BYTES = 256 * 1024;
const RPC_RESPONSE_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 1_000;
const MAX_WINDOWS_COMMAND_LINE_CODE_UNITS = 32_767;

interface ProcessSettlement {
  code: number;
  cancelled: boolean;
  timedOut: boolean;
  completed: boolean;
  launchError?: string;
}

interface AssistantEvent {
  type?: string;
  id?: string;
  success?: boolean;
  error?: string;
  event?: string;
  data?: unknown;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  };
}

interface PendingRpcCommand {
  command: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onAccepted?: (response: AssistantEvent) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type ChildRpcCommand = { type: "get_state" | "get_commands" } | { type: "prompt" | "steer"; message: string };

export async function runChild(request: ChildRequest): Promise<ChildResult> {
  if (request.signal.aborted) return cancelledResult();
  try {
    assertChildCommandCapacity(request);
    const invocation = resolvePiInvocation(buildPiArgs(request));
    return await executeProcess(invocation, request);
  } catch (error) {
    if (request.signal.aborted) return cancelledResult();
    return {
      state: "failed",
      error: truncateText(
        redactAttachmentPaths(error instanceof Error ? error.message : String(error), request),
        MAX_ERROR_BYTES,
      ).text,
      limitations: [],
      truncated: false,
    };
  }
}

type ChildCommandRequest = Pick<
  ChildRequest,
  "tools" | "skills" | "extensions" | "model" | "thinkingLevel" | "projectTrusted"
>;

export function buildPiArgs(request: ChildCommandRequest): string[] {
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "-e",
    childCommunicationBridgePath(),
  ];
  for (const extension of request.extensions) args.push("-e", extension.path);
  if (requiresReadinessAttestation(request)) args.push("-e", childReadinessProbePath());
  for (const skill of request.skills) args.push("--skill", skill);
  args.push(
    "--model",
    request.model,
    "--thinking",
    request.thinkingLevel,
    request.projectTrusted ? "--approve" : "--no-approve",
  );
  args.push("--tools", selectedChildTools(request).join(","));
  return args;
}

export function assertChildCommandCapacity(
  request: ChildCommandRequest,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  const invocation = resolvePiInvocation(buildPiArgs(request));
  const commandLineLength = [invocation.command, ...invocation.args].map(quoteWindowsArgument).join(" ").length;
  if (commandLineLength + 1 > MAX_WINDOWS_COMMAND_LINE_CODE_UNITS) {
    throw new Error("Subagent child command line exceeds the Windows process limit.");
  }
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
    } else {
      quoted += `${"\\".repeat(backslashes)}${character}`;
    }
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function childCommunicationBridgePath(): string {
  return fileURLToPath(new URL("./child-communication-bridge.ts", import.meta.url));
}

export function childReadinessProbePath(): string {
  return fileURLToPath(new URL("./child-readiness-probe.ts", import.meta.url));
}

function requiresReadinessAttestation(request: Pick<ChildRequest, "extensions">): boolean {
  return request.extensions.length > 0;
}

function selectedChildTools(request: Pick<ChildRequest, "tools" | "extensions">): string[] {
  return [
    ...new Set([
      ...request.tools,
      ...CHILD_COMMUNICATION_TOOL_NAMES,
      ...request.extensions.flatMap((extension) => extension.tools),
    ]),
  ];
}

async function executeProcess(
  invocation: { command: string; args: string[] },
  request: ChildRequest,
): Promise<ChildResult> {
  const timeoutMs = resolveTimeoutMs(request.timeout);
  const expectedTools = selectedChildTools(request);
  const expectReadiness = requiresReadinessAttestation(request);
  if (expectReadiness) assertChildBootstrapCapacity(expectedTools);
  let latestOutput = "";
  let terminalOutput: string | undefined;
  let terminalStopReason: "stop" | "length" | undefined;
  let errorMessage = "";
  let assistantFailed = false;
  let stderr = "";
  let stderrRedactionCarry = "";
  const stderrDecoder = new StringDecoder("utf8");
  const diagnosticAttachmentPaths = attachmentPathVariants(request);
  let truncated = false;
  const appendStderr = (value: string) => {
    if (!value) return;
    const limited = truncateTail(`${stderr}${value}`, MAX_ERROR_BYTES);
    stderr = limited.text;
    truncated ||= limited.truncated;
  };
  const pushStderr = (chunk: Buffer | string) => {
    const combined = `${stderrRedactionCarry}${typeof chunk === "string" ? chunk : stderrDecoder.write(chunk)}`;
    const carryLength = attachmentPathCarryLength(combined, diagnosticAttachmentPaths);
    const boundary = combined.length - carryLength;
    appendStderr(redactAttachmentPathVariants(combined.slice(0, boundary), diagnosticAttachmentPaths));
    stderrRedactionCarry = combined.slice(boundary);
  };
  const flushStderr = () => {
    const combined = `${stderrRedactionCarry}${stderrDecoder.end()}`;
    const carryLength = attachmentPathCarryLength(combined, diagnosticAttachmentPaths);
    const boundary = combined.length - carryLength;
    appendStderr(
      `${redactAttachmentPathVariants(combined.slice(0, boundary), diagnosticAttachmentPaths)}${
        carryLength > 0 ? "[attachment path]" : ""
      }`,
    );
    stderrRedactionCarry = "";
  };
  let malformedEvents = 0;
  let rpcCounter = 0;
  let attachmentStartupPending = expectReadiness;
  let attachmentStartupError: string | undefined;
  const pendingCommands = new Map<string, PendingRpcCommand>();
  let rpcInputError: Error | undefined;
  let sendCommand: (
    command: ChildRpcCommand,
    onAccepted?: (response: AssistantEvent) => void,
    signal?: AbortSignal,
  ) => Promise<void> = () => Promise.reject(new Error("Subagent RPC process is unavailable."));
  let onAgentSettled: () => void = () => undefined;

  const takePendingCommand = (id: string): PendingRpcCommand | undefined => {
    const pending = pendingCommands.get(id);
    if (!pending) return undefined;
    pendingCommands.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  };
  const rejectPendingCommand = (id: string, error: Error) => {
    takePendingCommand(id)?.reject(error);
  };
  const rejectPendingCommands = (error: Error) => {
    for (const id of [...pendingCommands.keys()]) rejectPendingCommand(id, error);
  };
  const resolvePendingCommand = (id: string, response: AssistantEvent) => {
    const pending = takePendingCommand(id);
    if (!pending) return;
    try {
      pending.onAccepted?.(response);
      pending.resolve();
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const failRpcInput = (error: Error) => {
    rpcInputError ??= error;
    rejectPendingCommands(rpcInputError);
  };

  const decoder = new JsonLineDecoder(
    (value) => {
      const event = value as AssistantEvent;
      if (
        expectReadiness &&
        event.type === "extension_error" &&
        (event.event === "session_start" || event.event === "resources_discover") &&
        !attachmentStartupError
      ) {
        const detail =
          typeof event.error === "string" && event.error
            ? redactAttachmentPaths(sanitizeTerminalText(event.error), request)
            : "Unknown error.";
        attachmentStartupError = `Subagent attachment startup failed during ${event.event}: ${detail}`;
        return;
      }
      if (event.type === "response" && typeof event.id === "string") {
        const pending = pendingCommands.get(event.id);
        if (!pending) return;
        if (event.success === true) {
          resolvePendingCommand(event.id, event);
        } else {
          rejectPendingCommand(
            event.id,
            new Error(
              pending.command === "get_commands"
                ? "Subagent child resource attestation failed."
                : typeof event.error === "string"
                  ? event.error
                  : `Subagent RPC ${pending.command} command failed.`,
            ),
          );
        }
        return;
      }
      if (event.type === "agent_settled") {
        onAgentSettled();
        return;
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = (event.message.content ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (text) {
          const limited = truncateText(text, MAX_OUTPUT_BYTES);
          latestOutput = limited.text;
          truncated ||= limited.truncated;
          if (event.message.stopReason === "stop" || event.message.stopReason === "length") {
            terminalOutput = limited.text;
            terminalStopReason = event.message.stopReason;
          }
        }
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
          assistantFailed = true;
        }
        if (event.message.errorMessage) {
          const limited = truncateText(redactAttachmentPaths(event.message.errorMessage, request), MAX_ERROR_BYTES);
          errorMessage = limited.text;
          truncated ||= limited.truncated;
        }
      }
    },
    () => {
      malformedEvents++;
      if (attachmentStartupPending && !attachmentStartupError) {
        attachmentStartupError = "Subagent attachment startup emitted malformed or oversized RPC output.";
      }
    },
  );

  const settlement = await new Promise<ProcessSettlement>((resolve) => {
    let process: ChildProcess;
    let settled = false;
    let finishRequested = false;
    let spawned = false;
    let terminating = false;
    let cancelled = false;
    let timedOut = false;
    let completed = false;
    let ready = false;
    let attachmentReady = !expectReadiness;
    let promptStarted = false;
    let readinessPipe: import("node:stream").Readable | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let forceClose: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let termination: Promise<void> | undefined;

    const finish = (code: number, launchError?: string) => {
      if (settled || finishRequested) return;
      finishRequested = true;
      const complete = () => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (forceClose) clearTimeout(forceClose);
        if (escalation) clearTimeout(escalation);
        request.signal.removeEventListener("abort", onAbort);
        readinessPipe?.removeAllListeners();
        readinessPipe?.destroy();
        rejectPendingCommands(new Error("Subagent RPC process closed."));
        resolve({ code, cancelled, timedOut, completed, launchError });
      };
      if (termination) void termination.then(complete, complete);
      else complete();
    };
    const terminate = (code: number) => {
      if (settled || terminating) return;
      terminating = true;
      if (deadline) {
        clearTimeout(deadline);
        deadline = undefined;
      }
      if (globalThis.process.platform === "win32") {
        termination = terminateWindowsProcessTree(process);
      } else {
        signalPosixProcess(process, "SIGTERM");
        escalation = setTimeout(() => signalPosixProcess(process, "SIGKILL"), KILL_GRACE_MS);
        escalation.unref();
      }
      forceClose = setTimeout(() => {
        decoder.finish();
        process.stdin?.destroy();
        process.stdout?.destroy();
        process.stderr?.destroy();
        readinessPipe?.destroy();
        finish(code);
      }, KILL_GRACE_MS * 2);
      forceClose.unref();
    };
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      terminate(130);
    };
    const completeNormally = () => {
      if (settled || terminating || !ready) return;
      completed = true;
      terminate(0);
    };
    onAgentSettled = completeNormally;

    try {
      const environment: NodeJS.ProcessEnv = {
        ...globalThis.process.env,
        ...childBootstrapEnvironment(expectReadiness),
        PI_SUBAGENT_DEPTH: String((Number.parseInt(globalThis.process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) + 1),
      };
      if (!expectReadiness) delete environment[CHILD_READINESS_FD_ENV];
      process = spawn(invocation.command, invocation.args, {
        cwd: request.cwd,
        detached: globalThis.process.platform !== "win32",
        shell: false,
        stdio: expectReadiness ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
        env: environment,
      });
    } catch (error) {
      finish(1, error instanceof Error ? error.message : String(error));
      return;
    }

    process.stdin?.on("error", failRpcInput);
    sendCommand = (command, onAccepted, signal) => {
      if (settled || terminating || process.exitCode !== null) {
        return Promise.reject(new Error("Subagent RPC process is no longer active."));
      }
      if (signal?.aborted) {
        return Promise.reject(abortError("Subagent RPC command was cancelled."));
      }
      if (rpcInputError) return Promise.reject(rpcInputError);
      const stdin = process.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        return Promise.reject(new Error("Subagent RPC stdin is unavailable."));
      }
      const id = `rpc_${++rpcCounter}`;
      return new Promise<void>((resolveCommand, rejectCommand) => {
        const timer = setTimeout(
          () => rejectPendingCommand(id, new Error(`Subagent RPC ${command.type} response timed out.`)),
          RPC_RESPONSE_TIMEOUT_MS,
        );
        timer.unref();
        const pending: PendingRpcCommand = {
          command: command.type,
          resolve: resolveCommand,
          reject: rejectCommand,
          timer,
          onAccepted,
          signal,
        };
        if (signal) {
          pending.onAbort = () => rejectPendingCommand(id, abortError("Subagent RPC command was cancelled."));
        }
        pendingCommands.set(id, pending);
        if (signal && pending.onAbort) {
          signal.addEventListener("abort", pending.onAbort, { once: true });
          if (signal.aborted) {
            pending.onAbort();
            return;
          }
        }
        try {
          stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
            if (error) failRpcInput(error);
          });
        } catch (error) {
          failRpcInput(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    const startPrompt = () => {
      if (!spawned || !attachmentReady || promptStarted || settled || cancelled || terminating) return;
      promptStarted = true;
      void sendCommand(
        { type: "prompt", message: `Task: ${request.task}` },
        () => {
          if (settled || terminating || request.signal.aborted) {
            throw new Error("Subagent RPC prompt was superseded.");
          }
          ready = true;
          if (timeoutMs !== undefined) {
            deadline = setTimeout(() => {
              timedOut = true;
              terminate(124);
            }, timeoutMs);
            deadline.unref();
          }
          const control: ChildControl = {
            send: async (message, signal) => {
              if (!ready || completed || terminating) {
                throw new Error("Subagent job is no longer accepting messages.");
              }
              await sendCommand({ type: "steer", message }, undefined, signal);
            },
          };
          request.onControl?.(control);
        },
        request.signal,
      ).catch((error) => {
        if (settled || terminating) return;
        errorMessage = truncateText(
          redactAttachmentPaths(error instanceof Error ? error.message : String(error), request),
          MAX_ERROR_BYTES,
        ).text;
        terminate(1);
      });
    };
    const failReadiness = (message: string) => {
      if (settled || terminating || attachmentReady) return;
      errorMessage = truncateText(redactAttachmentPaths(message, request), MAX_ERROR_BYTES).text;
      terminate(1);
    };
    const confirmAttachmentStartup = () => {
      void sendCommand({ type: "get_state" }, undefined, request.signal)
        .then(async () => {
          if (attachmentStartupError) throw new Error(attachmentStartupError);
          if (!request.projectTrusted) {
            // Pi's RPC get_commands includes effective skills and prompts after resources_discover.
            // RPC themes have no UI or model-visible representation.
            await sendCommand(
              { type: "get_commands" },
              (response) => assertTrustedChildResources(response.data, request.cwd),
              request.signal,
            );
          }
          if (attachmentStartupError) throw new Error(attachmentStartupError);
          attachmentStartupPending = false;
          attachmentReady = true;
          startPrompt();
        })
        .catch((error) => {
          failReadiness(error instanceof Error ? error.message : String(error));
        });
    };

    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    process.once("spawn", () => {
      spawned = true;
      startPrompt();
    });
    if (expectReadiness) {
      const candidate = process.stdio[CHILD_READINESS_FD];
      if (!candidate || !("on" in candidate)) {
        errorMessage = "Subagent readiness pipe is unavailable.";
        terminate(1);
      } else {
        readinessPipe = candidate as import("node:stream").Readable;
        let buffer = Buffer.alloc(0);
        let readinessSettled = false;
        readinessPipe.on("data", (chunk: Buffer | string) => {
          if (readinessSettled || terminating) return;
          buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
          if (buffer.byteLength > MAX_READINESS_FRAME_BYTES) {
            readinessSettled = true;
            failReadiness("Subagent readiness frame exceeded its size limit.");
          }
        });
        readinessPipe.once("end", () => {
          if (readinessSettled || terminating) return;
          readinessSettled = true;
          let frame: { ok: true; sources: string[] } | { ok: false; error: string };
          try {
            frame = parseReadinessFrame(buffer, expectedTools.length);
          } catch (error) {
            failReadiness(error instanceof Error ? error.message : String(error));
            return;
          }
          if (!frame.ok) {
            failReadiness(frame.error);
            return;
          }
          for (const extension of request.extensions) {
            for (const tool of extension.tools) {
              const source = frame.sources[expectedTools.indexOf(tool)];
              if (
                !source ||
                !Object.hasOwn(request.toolSources, tool) ||
                !request.toolSources[tool]?.includes(source)
              ) {
                failReadiness(`Subagent extension tool ${tool} was not provided by its requested attachment.`);
                return;
              }
            }
          }
          confirmAttachmentStartup();
        });
        readinessPipe.once("error", () => {
          if (readinessSettled || terminating) return;
          readinessSettled = true;
          failReadiness("Subagent readiness transfer failed.");
        });
        readinessPipe.once("close", () => {
          if (readinessSettled || terminating) return;
          readinessSettled = true;
          failReadiness("Subagent readiness pipe closed without a result.");
        });
      }
    }
    process.stdout?.on("data", (chunk) => decoder.push(chunk));
    process.stderr?.on("data", (chunk: Buffer | string) => pushStderr(chunk));
    process.once("close", (code) => {
      flushStderr();
      decoder.finish();
      finish(cancelled ? 130 : timedOut ? 124 : completed ? 0 : (code ?? 1));
    });
    process.once("error", (error) => {
      const limited = truncateText(redactAttachmentPaths(error.message, request), MAX_ERROR_BYTES);
      errorMessage = limited.text;
      truncated ||= limited.truncated;
      if (spawned) terminate(1);
      else finish(1, error.message);
    });
    const credentialPipe = process.stdio[BROKER_CREDENTIAL_FD];
    if (!credentialPipe || !("end" in credentialPipe)) {
      errorMessage = "Subagent broker credential pipe is unavailable.";
      terminate(1);
    } else {
      const onCredentialError = () => {
        if (settled || finishRequested) return;
        errorMessage = "Subagent broker credential transfer failed.";
        terminate(1);
      };
      const removeCredentialListeners = () => {
        credentialPipe.removeListener("error", onCredentialError);
        credentialPipe.removeListener("close", removeCredentialListeners);
      };
      credentialPipe.on("error", onCredentialError);
      credentialPipe.once("close", removeCredentialListeners);
      try {
        credentialPipe.end(
          serializeChildBootstrap({
            communication: request.communication,
            expectedTools: expectReadiness ? expectedTools : [],
          }),
        );
      } catch {
        onCredentialError();
      }
    }
  });

  const output = terminalOutput ?? latestOutput;
  const limitations = malformedEvents > 0 ? [`Ignored ${malformedEvents} malformed or oversized child event(s).`] : [];
  if (truncated) limitations.push("Child output was truncated to runtime limits.");
  if (terminalStopReason === "length") {
    limitations.push("Child output ended at the model output limit and may be incomplete.");
  }
  if (settlement.cancelled) return cancelledResult(output, limitations, truncated);
  if (settlement.timedOut) {
    return {
      state: "timed_out",
      ...(output ? { result: output } : {}),
      error: "Subagent execution timed out.",
      limitations,
      truncated,
    };
  }
  const redactedStderr = truncateTail(redactAttachmentPaths(stderr.trim(), request), MAX_ERROR_BYTES);
  const combinedError = combineErrors(
    redactAttachmentPaths(settlement.launchError ?? "", request),
    redactAttachmentPaths(errorMessage, request),
    redactedStderr.text,
  );
  const error = combinedError.text;
  if ((combinedError.truncated || redactedStderr.truncated) && !truncated) {
    limitations.push("Child output was truncated to runtime limits.");
  }
  truncated ||= combinedError.truncated || redactedStderr.truncated;
  if (settlement.completed && terminalStopReason === "stop" && !assistantFailed && !errorMessage) {
    return {
      state: "completed",
      result: terminalOutput,
      limitations,
      truncated,
    };
  }
  const failure =
    error ||
    (terminalStopReason === "length"
      ? "Subagent output reached the model limit."
      : assistantFailed
        ? "Subagent model turn failed."
        : settlement.completed
          ? "Subagent settled without a terminal assistant result."
          : settlement.code === 0
            ? "Subagent exited without settling."
            : `Subagent exited with code ${settlement.code}.`);
  if (output) {
    return {
      state: "partial",
      result: output,
      error: failure,
      limitations,
      truncated,
    };
  }
  return {
    state: "failed",
    error: failure,
    limitations,
    truncated,
  };
}

function resolvePiInvocation(args: string[]): { command: string; args: string[] } {
  const packageDirectory = fs.realpathSync(getPackageDir());
  const manifestPath = path.join(packageDirectory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    name?: string;
    bin?: { pi?: string };
  };
  if (manifest.name !== CORE_PACKAGE_NAME || typeof manifest.bin?.pi !== "string") {
    throw new Error("Loaded Pi core package does not declare a valid bin.pi entry.");
  }
  const declared = manifest.bin.pi;
  if (path.isAbsolute(declared)) throw new Error("Pi core bin.pi must be package-relative.");
  if (
    globalThis.process.versions.bun &&
    /^pi(?:\.exe)?$/iu.test(path.basename(globalThis.process.execPath)) &&
    path.dirname(fs.realpathSync(globalThis.process.execPath)) === packageDirectory
  ) {
    return { command: globalThis.process.execPath, args };
  }
  const cliPath = fs.realpathSync(path.resolve(packageDirectory, declared));
  const relative = path.relative(packageDirectory, cliPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Pi core bin.pi escapes its package directory.");
  }
  if (!fs.statSync(cliPath).isFile()) throw new Error("Pi core bin.pi is not a file.");
  return { command: globalThis.process.execPath, args: [cliPath, ...args] };
}

function signalPosixProcess(process: ChildProcess, signal: NodeJS.Signals): void {
  if (process.pid) {
    try {
      globalThis.process.kill(-process.pid, signal);
      return;
    } catch {
      // Fall back to the immediate child.
    }
  }
  try {
    process.kill(signal);
  } catch {
    // The process may already be terminal.
  }
}

export function terminateWindowsProcessTree(
  process: ChildProcess,
  spawnProcess: typeof spawn = spawn,
  taskkillPath = resolveTaskkillPath(),
  helperTimeoutMs = KILL_GRACE_MS,
): Promise<void> {
  if (!process.pid || !taskkillPath) {
    killImmediateChild(process);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let treeKiller: ChildProcess;
    let deadline: NodeJS.Timeout | undefined;
    const onError = () => finish(true, false);
    const onClose = (code: number | null) => finish(code !== 0, false);
    const finish = (fallback: boolean, terminateHelper: boolean) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      treeKiller.removeListener("error", onError);
      treeKiller.removeListener("close", onClose);
      if (terminateHelper) killImmediateChild(treeKiller);
      if (fallback) killImmediateChild(process);
      resolve();
    };
    try {
      treeKiller = spawnProcess(taskkillPath, ["/PID", String(process.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      killImmediateChild(process);
      resolve();
      return;
    }
    treeKiller.once("error", onError);
    treeKiller.once("close", onClose);
    deadline = setTimeout(() => finish(true, true), helperTimeoutMs);
    deadline.unref();
  });
}

function resolveTaskkillPath(): string | undefined {
  const systemRoot = globalThis.process.env.SystemRoot ?? globalThis.process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return undefined;
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

function killImmediateChild(process: ChildProcess): void {
  try {
    process.kill("SIGKILL");
  } catch {
    // The process may already be terminal.
  }
}

function assertTrustedChildResources(value: unknown, cwd: string): void {
  const invalid = () => new Error("Subagent child resource attestation returned invalid commands.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const commands = (value as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) throw invalid();
  let canonicalCwd: string;
  try {
    canonicalCwd = fs.realpathSync(cwd);
  } catch {
    throw invalid();
  }
  for (const command of commands) {
    if (!command || typeof command !== "object" || Array.isArray(command)) throw invalid();
    const entry = command as { source?: unknown; sourceInfo?: { path?: unknown } };
    if (entry.source !== "skill" && entry.source !== "prompt") continue;
    const resourcePath = entry.sourceInfo?.path;
    if (typeof resourcePath !== "string" || !resourcePath) throw invalid();
    const lexicalPath = path.resolve(cwd, resourcePath);
    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(lexicalPath);
    } catch {
      throw invalid();
    }
    if (isWithin(cwd, lexicalPath) || isWithin(canonicalCwd, canonicalPath)) {
      throw new Error("Subagent child cannot load project resources because the project is not trusted.");
    }
  }
}

function parseReadinessFrame(
  buffer: Buffer,
  expectedToolCount: number,
): { ok: true; sources: string[] } | { ok: false; error: string } {
  if (buffer.byteLength === 0) {
    throw new Error("Subagent readiness pipe closed without a result.");
  }
  const text = buffer.toString("utf8");
  const newline = text.indexOf("\n");
  if (newline < 0 || newline !== text.length - 1) {
    throw new Error("Subagent readiness pipe returned an invalid frame.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, newline));
  } catch {
    throw new Error("Subagent readiness pipe returned malformed JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Subagent readiness pipe returned an invalid result.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.ok === true &&
    Object.keys(record).length === 2 &&
    Array.isArray(record.sources) &&
    record.sources.length === expectedToolCount &&
    record.sources.every((source) => typeof source === "string" && /^[a-f0-9]{64}$/u.test(source))
  ) {
    return { ok: true, sources: record.sources };
  }
  if (
    record.ok === false &&
    Object.keys(record).length === 2 &&
    typeof record.error === "string" &&
    record.error.length > 0 &&
    Buffer.byteLength(record.error, "utf8") <= MAX_ERROR_BYTES
  ) {
    return { ok: false, error: sanitizeTerminalText(record.error) };
  }
  throw new Error("Subagent readiness pipe returned an invalid result.");
}

function redactAttachmentPaths(value: string, request: Pick<ChildRequest, "skills" | "extensions">): string {
  return redactAttachmentPathVariants(value, attachmentPathVariants(request));
}

function redactAttachmentPathVariants(value: string, candidates: readonly string[]): string {
  let redacted = value;
  for (const candidate of candidates) redacted = redacted.replaceAll(candidate, "[attachment path]");
  return redacted;
}

function attachmentPathCarryLength(value: string, candidates: readonly string[]): number {
  const maximum = Math.min(
    value.length,
    candidates.reduce((length, candidate) => Math.max(length, candidate.length - 1), 0),
  );
  for (let length = maximum; length > 0; length--) {
    const suffix = value.slice(-length);
    if (candidates.some((candidate) => candidate.length > length && candidate.startsWith(suffix))) return length;
  }
  return 0;
}

function attachmentPathVariants(request: Pick<ChildRequest, "skills" | "extensions">): string[] {
  const variants = new Set<string>();
  const paths = [...request.skills, ...request.extensions.map((extension) => extension.path)];
  for (const resourcePath of paths) {
    for (const spelling of [resourcePath, resourcePath.replaceAll("\\", "/"), resourcePath.replaceAll("/", "\\")]) {
      if (!spelling) continue;
      variants.add(spelling);
      variants.add(JSON.stringify(spelling).slice(1, -1));
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function combineErrors(...messages: Array<string | undefined>): { text: string; truncated: boolean } {
  const unique = [...new Set(messages.filter((message): message is string => Boolean(message)))];
  return truncateText(unique.join("\n"), MAX_ERROR_BYTES);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function cancelledResult(result?: string, limitations: string[] = [], truncated = false): ChildResult {
  return {
    state: "cancelled",
    ...(result ? { result } : {}),
    error: "Subagent execution was cancelled.",
    limitations,
    truncated,
  };
}

function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return {
    text: `${bytes
      .subarray(0, Math.max(0, maxBytes - 18))
      .toString("utf8")
      .replace(/�+$/gu, "")}\n… [truncated]`,
    truncated: true,
  };
}

function truncateTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return {
    text: `… [truncated]\n${bytes
      .subarray(bytes.length - Math.max(0, maxBytes - 18))
      .toString("utf8")
      .replace(/^�+/gu, "")}`,
    truncated: true,
  };
}

class JsonLineDecoder {
  private buffer = "";
  private dropping = false;
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly onValue: (value: unknown) => void,
    private readonly onMalformed: () => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain(false);
  }

  finish(): void {
    this.buffer += this.decoder.end();
    this.drain(true);
    this.buffer = "";
    this.dropping = false;
  }

  private drain(flush: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (this.dropping) {
        this.dropping = false;
        continue;
      }
      this.parse(line);
    }
    if (!flush && Buffer.byteLength(this.buffer, "utf8") > MAX_EVENT_LINE_BYTES) {
      this.onMalformed();
      this.buffer = "";
      this.dropping = true;
    }
    if (flush && this.buffer && !this.dropping) this.parse(this.buffer.replace(/\r$/u, ""));
  }

  private parse(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
      this.onMalformed();
      return;
    }
    try {
      this.onValue(JSON.parse(line));
    } catch {
      this.onMalformed();
    }
  }
}
