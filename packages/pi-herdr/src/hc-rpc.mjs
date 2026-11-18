import net from "node:net";

export const HC_MAX_FRAME_BYTES = 2 * 1024 * 1024;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function response(frame, id = 1) {
  if (!record(frame) || frame.jsonrpc !== "2.0" || frame.id !== id) throw new Error("Invalid hc RPC response");
  if (Object.hasOwn(frame, "error")) {
    const kind = frame.error?.data?.kind;
    const suffix = typeof kind === "string" && /^[a-z_]{1,40}$/u.test(kind) ? ` (${kind})` : "";
    // Native messages can contain task text or argv. Publish only the stable error kind.
    throw new Error(`hc RPC rejected${suffix}; inspect the terminal before retrying`);
  }
  if (!Object.hasOwn(frame, "result")) throw new Error("Missing hc RPC result");
  return frame.result;
}

function connect(endpoint, { signal, timeoutMs, maxBytes, onFrame }) {
  if (typeof endpoint !== "string" || !endpoint.trim()) throw new Error("Missing inherited hc endpoint");
  if (signal?.aborted) throw new Error("hc operation cancelled; remote changes may have occurred");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid hc connection limits");
  const socket = net.createConnection(endpoint);
  let ending = false;
  let connected = false;
  socket.once("connect", () => {
    connected = true;
  });
  let reason;
  let pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const stop = (error) => {
    if (ending) return;
    ending = true;
    reason = error;
    socket.destroy();
  };
  const abort = () => stop(new Error("hc operation cancelled; remote changes may have occurred"));
  const timer = setTimeout(() => stop(new Error("hc connection timed out; outcome may be ambiguous")), timeoutMs);
  timer.unref?.();
  signal?.addEventListener("abort", abort, { once: true });
  socket.on("error", () => stop(new Error("hc socket failed; outcome may be ambiguous")));
  socket.on("timeout", () => stop(new Error("hc subscription heartbeat timed out")));
  socket.on("data", (chunk) => {
    if (ending) return;
    try {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0 && !ending) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > maxBytes) throw new Error("hc frame exceeded the limit");
        if (!line.trim()) throw new Error("Empty hc frame");
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          throw new Error("Invalid hc JSON frame");
        }
        onFrame(frame);
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > maxBytes) throw new Error("hc frame exceeded the limit");
    } catch (error) {
      stop(error instanceof Error ? error : new Error("Invalid hc frame"));
    }
  });
  socket.once("end", () => stop(new Error("hc socket ended")));
  socket.once("close", () => {
    ending = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    socket.removeAllListeners("data");
    resolveClosed(reason);
  });
  return {
    closed,
    send(method, params, id = 1) {
      let line;
      try {
        line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      } catch {
        stop(new Error("Invalid hc request"));
        return;
      }
      if (Buffer.byteLength(line) > maxBytes) {
        stop(new Error("hc request exceeded the limit"));
        return;
      }
      const write = () => {
        if (!ending) socket.write(line);
      };
      if (connected) write();
      else socket.once("connect", write);
    },
    established() {
      clearTimeout(timer);
    },
    subscribed() {
      clearTimeout(timer);
      socket.setTimeout(45_000);
    },
    async close() {
      stop();
      await closed;
    },
  };
}

/** One bounded RPC on its own socket; closing it never rolls back a remote mutation. */
export function requestHc(
  endpoint,
  method,
  params = {},
  { signal, timeoutMs = 5000, maxBytes = HC_MAX_FRAME_BYTES } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const connection = connect(endpoint, {
      signal,
      timeoutMs,
      maxBytes,
      onFrame(frame) {
        const result = response(frame);
        settled = true;
        void connection.close().then(() => resolve(result));
      },
    });
    void connection.closed.then((error) => {
      if (!settled) reject(error ?? new Error("hc connection closed before acknowledgement"));
    });
    connection.send(method, params);
  });
}

/** Bind one operation to one core connection. A closed connection is never reopened. */
export async function withHcConnection(endpoint, operation, { signal, maxBytes = HC_MAX_FRAME_BYTES } = {}) {
  let nextId = 0;
  let closed = false;
  let pending;
  const connection = connect(endpoint, {
    signal,
    timeoutMs: 5000,
    maxBytes,
    onFrame(frame) {
      if (!pending) throw new Error("Unexpected hc RPC response");
      const result = response(frame, pending.id);
      connection.established();
      const received = pending;
      pending = undefined;
      clearTimeout(received.timer);
      received.resolve(result);
    },
  });
  const disconnected = new AbortController();
  void connection.closed.then((error) => {
    closed = true;
    disconnected.abort();
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error ?? new Error("hc connection closed before acknowledgement"));
    pending = undefined;
  });
  function request(method, params = {}, { timeoutMs = 5000 } = {}) {
    if (closed || signal?.aborted || pending) throw new Error("hc connection is not available");
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => void connection.close(), timeoutMs);
      timer.unref?.();
      pending = { id, resolve, reject, timer };
      connection.send(method, params, id);
    });
  }
  try {
    return await operation(request, disconnected.signal);
  } finally {
    await connection.close();
  }
}

/** Plain subscriptions own their socket; use separate requestHc calls for authoritative reads. */
export function subscribeHc(endpoint, { signal, onEvent, timeoutMs = 5000, maxBytes = HC_MAX_FRAME_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let acknowledged = false;
    const connection = connect(endpoint, {
      signal,
      timeoutMs,
      maxBytes,
      onFrame(frame) {
        if (!acknowledged) {
          const snapshot = response(frame);
          acknowledged = true;
          connection.subscribed();
          resolve({ snapshot, closed: connection.closed, close: () => connection.close() });
          return;
        }
        if (!record(frame) || frame.jsonrpc !== "2.0" || typeof frame.method !== "string" || !record(frame.params))
          throw new Error("Invalid hc notification");
        onEvent?.(frame);
      },
    });
    void connection.closed.then((error) => {
      if (!acknowledged) reject(error ?? new Error("hc subscription closed before acknowledgement"));
    });
    connection.send("events.subscribe", {});
  });
}
