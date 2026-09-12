import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  type BrokerSendAcknowledgement,
  MAX_IDENTIFIER_LENGTH,
  MAX_MESSAGE_BYTES,
  sanitizeTerminalText,
  validateMessage,
} from "./message-broker.js";

export const CHILD_COMMUNICATION_TOOL_NAMES = ["subagent_send", "subagent_wait"] as const;

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

const SendParameters = Type.Object(
  {
    requestId: Type.Optional(
      Type.String({
        description: "Pending main-agent request to answer. Omit when starting a new request.",
        minLength: 1,
        maxLength: MAX_IDENTIFIER_LENGTH,
      }),
    ),
    message: Type.String({
      description: "Plain-text request or response. Maximum 48 KiB of UTF-8 text and 1,992 lines.",
      minLength: 1,
      maxLength: MAX_MESSAGE_BYTES,
    }),
  },
  { additionalProperties: false },
);

const WaitParameters = Type.Object(
  {
    requestId: Type.String({
      description: "Request ID returned by subagent_send.",
      minLength: 1,
      maxLength: MAX_IDENTIFIER_LENGTH,
    }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  },
  { additionalProperties: false },
);

type ChildBrokerSendArguments = { recipient: "main"; message: string } | { requestId: string; message: string };

type WaitArguments = Static<typeof WaitParameters>;

export interface ChildCommunicationClient {
  send(params: ChildBrokerSendArguments, signal?: AbortSignal): Promise<BrokerSendAcknowledgement>;
  wait(requestId: string, timeoutMs: number | undefined, signal?: AbortSignal): Promise<string>;
}

export function createChildCommunicationExtension(client: ChildCommunicationClient): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "subagent_send",
      label: "Subagent · Send to Main",
      description:
        "Use subagent_send to send one request to the main agent or answer one pending main-agent request. Omit requestId to start a request. Provide requestId to answer that request.",
      promptSnippet: "Use subagent_send to send or answer one main-agent message",
      parameters: SendParameters,
      async execute(_toolCallId, params, signal) {
        validateMessage(params.message, "Subagent message");
        const requestId = optionalIdentifier(params.requestId, "requestId");
        const acknowledgement = await client.send(
          requestId === undefined
            ? { recipient: "main", message: params.message }
            : { requestId, message: params.message },
          signal,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(acknowledgement) }],
          details: acknowledgement,
        };
      },
    });

    pi.registerTool({
      name: "subagent_wait",
      label: "Subagent · Wait for Main Agent",
      description:
        "Use subagent_wait with a request ID from subagent_send to wait for the main agent's plain-text response. A timeout, caller cancellation, or incoming main-agent request stops only this wait and does not cancel the original request. Retry the wait when its response is still needed.",
      promptSnippet: "Use subagent_wait to receive a requested main-agent response",
      parameters: WaitParameters,
      prepareArguments: prepareWaitArguments,
      async execute(_toolCallId, params, signal) {
        const requestId = requiredIdentifier(params.requestId, "requestId");
        const response = await client.wait(requestId, resolveTimeoutMs(params.timeout), signal);
        return {
          content: [{ type: "text" as const, text: sanitizeTerminalText(response) }],
          details: { requestId },
        };
      },
    });
  };
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

function prepareWaitArguments(args: unknown): WaitArguments {
  if (!args || typeof args !== "object") return args as WaitArguments;
  if (!Object.hasOwn(args, "timeoutMs")) return args as WaitArguments;
  const record = args as Record<string, unknown>;
  if (typeof record.timeoutMs !== "number") return record as WaitArguments;
  const { timeoutMs, ...prepared } = record;
  if (prepared.timeout === undefined) {
    return { ...prepared, timeout: timeoutMs / 1000 } as WaitArguments;
  }
  return prepared as WaitArguments;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredIdentifier(value, field);
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Subagent ${field} is required.`);
  const identifier = value.trim();
  if (
    identifier.length > MAX_IDENTIFIER_LENGTH ||
    [...identifier].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    throw new Error(`Subagent ${field} is invalid.`);
  }
  return identifier;
}
