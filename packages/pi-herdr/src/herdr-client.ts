import net from "node:net";

export const MAX_HERDR_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_SUBSCRIPTION_EVENTS = 1024;

export interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrSubscription {
  closed: Promise<void>;
  close(): void;
}

class NdjsonFrames {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_HERDR_FRAME_BYTES && this.buffer.indexOf(0x0a) < 0) {
      throw new Error("Herdr response frame exceeded the size limit");
    }

    const frames: unknown[] = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_HERDR_FRAME_BYTES) {
        throw new Error("Herdr response frame exceeded the size limit");
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      try {
        frames.push(JSON.parse(line.toString("utf8")));
      } catch {
        throw new Error("Herdr returned invalid JSON");
      }
    }
    if (this.buffer.length > MAX_HERDR_FRAME_BYTES) {
      throw new Error("Herdr response frame exceeded the size limit");
    }
    return frames;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Herdr request aborted", "AbortError");
}

class HerdrApiError extends Error {
  readonly code: string | undefined;

  constructor(error: Record<string, unknown>) {
    super(`Herdr ${typeof error.message === "string" ? error.message : "request failed"}`);
    this.code = typeof error.code === "string" ? error.code : undefined;
  }
}

function responseError(frame: Record<string, unknown>): Error | undefined {
  if (!("error" in frame)) return undefined;
  if (!isRecord(frame.error)) return new Error("Herdr returned an invalid error response");
  return new HerdrApiError(frame.error);
}

export function createBestEffortSender(socketEndpoint: string) {
  return async (request: HerdrRequest, signal: AbortSignal): Promise<void> => {
    for (const timeoutMs of [500, 1500]) {
      if (signal.aborted) return;
      try {
        const result = await requestHerdr(socketEndpoint, request, signal, timeoutMs);
        if (isRecord(result) && result.type === "ok") return;
      } catch (error) {
        // API rejection is not a transport outage. Do not repeat a rejected report.
        if (signal.aborted || error instanceof HerdrApiError) return;
      }
    }
  };
}

export function requestHerdr(
  socketEndpoint: string,
  request: HerdrRequest,
  signal: AbortSignal,
  timeoutMs = 1500,
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const payload = `${JSON.stringify(request)}\n`;
    const socket = net.createConnection(socketEndpoint);
    const parser = new NdjsonFrames();
    let finished = false;
    const timeout = setTimeout(() => finish(new Error("Herdr request timed out")), timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      socket.destroy();
    };
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(abortReason(signal));

    signal.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => {
      if (!finished) socket.write(payload);
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("Herdr closed the request before responding")));
    socket.on("close", () => finish(new Error("Herdr request socket closed")));
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      try {
        for (const value of parser.push(chunk)) {
          if (!isRecord(value)) continue;
          const uncorrelatedError = responseError(value);
          if (uncorrelatedError && (value.id === "" || value.id === undefined)) {
            finish(uncorrelatedError);
            return;
          }
          if (value.id !== request.id) continue;
          const error = responseError(value);
          if (error) {
            finish(error);
            return;
          }
          if (!("result" in value)) {
            finish(new Error("Herdr response did not include a result"));
            return;
          }
          finish(undefined, value.result);
          return;
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function openHerdrSubscription(
  socketEndpoint: string,
  request: HerdrRequest,
  signal: AbortSignal,
  onEvent: (frame: unknown) => void,
  timeoutMs = 1500,
): Promise<HerdrSubscription> {
  if (signal.aborted) throw abortReason(signal);

  const payload = `${JSON.stringify(request)}\n`;
  const socket = net.createConnection(socketEndpoint);
  const parser = new NdjsonFrames();
  const pendingEvents: unknown[] = [];
  let ready = false;
  let finished = false;
  let intentionalClose = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => undefined);
  const timeout = setTimeout(() => finish(new Error("Herdr subscription timed out")), timeoutMs);
  timeout.unref?.();

  const cleanup = () => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    socket.destroy();
  };
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (!ready) {
      if (error && !intentionalClose) rejectReady(error);
      else rejectReady(abortReason(signal));
      resolveClosed();
      return;
    }
    if (error && !intentionalClose) rejectClosed(error);
    else resolveClosed();
  };
  const deliver = (frame: unknown) => {
    if (finished) return;
    try {
      onEvent(frame);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const abort = () => {
    intentionalClose = true;
    finish();
  };

  signal.addEventListener("abort", abort, { once: true });
  socket.on("connect", () => {
    if (!finished) socket.write(payload);
  });
  socket.on("error", (error) => finish(error));
  socket.on("end", () => finish(new Error("Herdr subscription closed")));
  socket.on("close", () => finish(new Error("Herdr subscription socket closed")));
  socket.on("data", (chunk: Buffer) => {
    if (finished) return;
    try {
      for (const value of parser.push(chunk)) {
        if (finished) return;
        if (isRecord(value)) {
          const error = responseError(value);
          if (error && (value.id === request.id || value.id === "" || value.id === undefined)) {
            finish(error);
            return;
          }
          if ("id" in value && value.id !== request.id) continue;
        }
        if (!ready) {
          if (isRecord(value) && value.id === request.id) {
            if (!isRecord(value.result) || value.result.type !== "subscription_started") {
              finish(new Error("Herdr returned an invalid subscription acknowledgement"));
              return;
            }
            ready = true;
            clearTimeout(timeout);
            resolveReady();
            for (const event of pendingEvents.splice(0)) deliver(event);
            continue;
          }
          if (pendingEvents.length >= MAX_PENDING_SUBSCRIPTION_EVENTS) {
            finish(new Error("Too many Herdr events arrived before subscription acknowledgement"));
            return;
          }
          pendingEvents.push(value);
          continue;
        }
        deliver(value);
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

  await readyPromise;
  if (signal.aborted) {
    intentionalClose = true;
    finish();
    throw abortReason(signal);
  }
  return {
    closed,
    close() {
      intentionalClose = true;
      finish();
    },
  };
}
