import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

const MAX_STARTUP_STDERR_BYTES = 64 * 1024;

function handleErrorsUntilClose(emitter: EventEmitter) {
  // Cancellation or readiness can settle before an already queued process/pipe error.
  // Keep the resource safe until close, then remove this lifetime-only handler.
  const ignoreError = () => undefined;
  emitter.on("error", ignoreError);
  emitter.once("close", () => emitter.off("error", ignoreError));
}

export function browserWebSocketIdentity(value: unknown, port: number): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "ws:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      Number(url.port || "80") !== port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/devtools\/browser\/[^/]+$/.test(url.pathname)
    ) {
      return undefined;
    }
    return url.pathname;
  } catch {
    return undefined;
  }
}

// A free-port probe cannot reserve the port through Chrome's startup. Use the owned child's
// announcement, not an arbitrary responding HTTP server, as the browser identity authority.
export function waitForBrowserStartup(
  child: ChildProcess,
  port: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<string> {
  handleErrorsUntilClose(child);
  const stderr = child.stderr;
  if (stderr && !stderr.closed) handleErrorsUntilClose(stderr);
  signal.throwIfAborted();
  if (!stderr) return Promise.reject(new Error("Auto-launched browser has no startup stderr stream."));

  return new Promise<string>((resolve, reject) => {
    let spawned = false;
    let identity: string | undefined;
    let receivedBytes = 0;
    let pendingLine = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const settle = (error?: Error) => {
      if (settled) return;
      if (!error && (!spawned || !identity)) return;
      settled = true;
      clearTimeout(timeout);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onExit);
      stderr.off("data", onData);
      stderr.off("end", onEnd);
      stderr.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      // Keep the pipe drained after startup without retaining or displaying browser logs.
      stderr.resume();
      if (error) reject(error);
      else resolve(identity as string);
    };
    const onError = (error: Error) => settle(error);
    const onAbort = () => settle(new Error("Chrome DevTools browser startup cancelled.", { cause: signal.reason }));
    const onExit = () => settle(new Error("Auto-launched browser exited before DevTools became available."));
    const onSpawn = () => {
      spawned = true;
      timeout = setTimeout(
        () => settle(new Error("Timed out waiting for auto-launched browser DevTools startup announcement.")),
        waitMs,
      );
      settle();
    };
    const inspectLine = (line: string) => {
      const match = /^DevTools listening on (\S+)$/.exec(line.trim());
      if (!match) return;
      identity = browserWebSocketIdentity(match[1], port);
      if (!identity) settle(new Error("Auto-launched browser announced an unexpected DevTools endpoint."));
      else settle();
    };
    const onData = (data: Buffer | string) => {
      receivedBytes += Buffer.byteLength(data);
      if (receivedBytes > MAX_STARTUP_STDERR_BYTES) {
        settle(new Error("Auto-launched browser startup stderr exceeded 64 KB before readiness."));
        return;
      }
      pendingLine += data.toString();
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        inspectLine(line);
        if (settled) break;
      }
    };
    const onEnd = () => {
      inspectLine(pendingLine);
      if (!identity) settle(new Error("Auto-launched browser closed stderr before its DevTools startup announcement."));
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onExit);
    stderr.on("data", onData);
    stderr.once("end", onEnd);
    stderr.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
