import net from "node:net";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { captureBrokerCredentials } from "./broker-credentials.js";
import { type ChildCommunicationClient, createChildCommunicationExtension } from "./child-communication-tools.js";
import { MAX_FRAME_BYTES, MAX_IDENTIFIER_LENGTH } from "./message-broker.js";
import type { BrokerCredentials } from "./types.js";

const CONNECT_TIMEOUT_MS = 2_000;
const SEND_RESPONSE_TIMEOUT_MS = 5_000;

const captured = captureBrokerCredentials();

const childCommunicationBridge: ExtensionFactory = captured
  ? createChildCommunicationExtension(createBrokerClient(captured))
  : () => undefined;

export default childCommunicationBridge;

export function createBrokerClient(credentials: BrokerCredentials): ChildCommunicationClient {
  return {
    async send(params, signal) {
      const response = await requestBroker(
        credentials,
        { type: "send", token: credentials.token, ...params },
        signal,
        SEND_RESPONSE_TIMEOUT_MS,
      );
      if (response.ok !== true) throw brokerError(response);
      if (
        typeof response.requestId !== "string" ||
        !response.requestId ||
        response.requestId.length > MAX_IDENTIFIER_LENGTH ||
        typeof response.accepted !== "boolean" ||
        typeof response.duplicate !== "boolean"
      ) {
        throw new Error("Subagent broker returned an invalid send acknowledgement.");
      }
      return {
        requestId: response.requestId,
        accepted: response.accepted,
        duplicate: response.duplicate,
      };
    },
    async wait(requestId, timeoutMs, signal) {
      const response = await requestBroker(
        credentials,
        {
          type: "wait",
          token: credentials.token,
          requestId,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        signal,
      );
      if (response.ok !== true) throw brokerError(response);
      if (typeof response.response !== "string") {
        throw new Error("Subagent broker returned an invalid plain-text response.");
      }
      return response.response;
    },
  };
}

function requestBroker(
  credentials: BrokerCredentials,
  request: Record<string, unknown>,
  signal?: AbortSignal,
  responseTimeoutMs?: number,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) return Promise.reject(abortError("Subagent broker request was cancelled."));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: credentials.host, port: credentials.port });
    let response = Buffer.alloc(0);
    let settled = false;
    let responseTimer: NodeJS.Timeout | undefined;
    const connectTimer = setTimeout(
      () => finish(new Error("Subagent broker connection timed out.")),
      CONNECT_TIMEOUT_MS,
    );
    connectTimer.unref();
    const onAbort = () => finish(abortError("Subagent broker request was cancelled."));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (responseTimer) clearTimeout(responseTimer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      if (responseTimeoutMs !== undefined) {
        responseTimer = setTimeout(() => finish(new Error("Subagent broker response timed out.")), responseTimeoutMs);
        responseTimer.unref();
      }
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      response = Buffer.concat([response, chunk]);
      if (response.byteLength > MAX_FRAME_BYTES) {
        finish(new Error("Subagent broker response exceeded its size limit."));
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      const trailing = response
        .subarray(newline + 1)
        .toString("utf8")
        .trim();
      if (trailing) {
        finish(new Error("Subagent broker returned more than one response frame."));
        return;
      }
      try {
        const parsed = JSON.parse(response.subarray(0, newline).toString("utf8")) as unknown;
        if (!isRecord(parsed)) throw new Error();
        finish(undefined, parsed);
      } catch {
        finish(new Error("Subagent broker returned malformed JSON."));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("Subagent broker closed without a response."));
    });
  });
}

function brokerError(response: Record<string, unknown>): Error {
  return new Error(typeof response.error === "string" ? response.error : "Subagent broker rejected the request.");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
