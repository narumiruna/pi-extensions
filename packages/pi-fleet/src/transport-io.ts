import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { createConnection, type Server, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import { JsonLineDecoder, MAX_FRAME_BYTES, type SignedFleetFrame } from "./protocol.js";

export function requestFrame(
  endpointPath: string,
  frame: SignedFleetFrame,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  assertPositiveDuration(timeoutMs, "Pi Fleet request timeout");
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let received = false;
    const socket = createConnection(endpointPath);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const decoder = new JsonLineDecoder({
      onValue: (value) => {
        if (received) {
          finish(new Error("Pi Fleet peer returned multiple response frames"));
          return;
        }
        received = true;
        finish(undefined, value);
      },
      onError: (error) => finish(error),
    });
    const timer = setTimeout(
      () => finish(new FleetEndpointError("ETIMEDOUT", "Pi Fleet request timed out")),
      timeoutMs,
    );
    timer.unref();
    const onAbort = () => finish(abortError("Pi Fleet request aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      void writeFrame(socket, frame).catch((error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
    socket.on("data", (chunk) => decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(new FleetEndpointError(error.code ?? "EIO", `Pi Fleet endpoint failed: ${error.code ?? "I/O error"}`));
    });
    socket.once("close", () => {
      if (!settled) {
        finish(new FleetEndpointError("ECONNRESET", "Pi Fleet endpoint closed without a response"));
      }
    });
    if (signal?.aborted) onAbort();
  });
}

export async function writeFrame(socket: Socket, frame: SignedFleetFrame): Promise<void> {
  const data = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (data.length > MAX_FRAME_BYTES) throw new Error("Pi Fleet frame is too large");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    socket.write(data, (error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

export function listenSocketServer(server: Server, path: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      server.off("error", onError);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onError = (error: Error) => finish(error);
    const onAbort = () => {
      server.close();
      finish(abortError("Pi Fleet transport start aborted"));
    };
    server.once("error", onError);
    server.listen(path, () => finish());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function closeSocketServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    try {
      server.close(() => resolvePromise());
    } catch {
      resolvePromise();
    }
  });
}

export async function readBoundedUtf8(path: string, maximum: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await readBoundedHandleUtf8(handle, maximum);
  } finally {
    await handle.close();
  }
}

export async function readBoundedHandleUtf8(handle: FileHandle, maximum: number): Promise<string> {
  const buffer = Buffer.alloc(maximum + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximum) throw new Error("Pi Fleet endpoint manifest is too large");
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
}

export class FleetEndpointError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FleetEndpointError";
  }
}

export function isDeadEndpointError(error: unknown): boolean {
  return (
    error instanceof FleetEndpointError &&
    (error.code === "ENOENT" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ECONNRESET" ||
      error.code === "ETIMEDOUT")
  );
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${label} is invalid`);
}
