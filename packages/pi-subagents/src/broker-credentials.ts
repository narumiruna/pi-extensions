import * as fs from "node:fs";
import type { BrokerCredentials } from "./types.js";

export const BROKER_CREDENTIAL_FD = 3;
export const BROKER_CREDENTIAL_FD_ENV = "PI_SUBAGENT_BROKER_FD";

const MAX_CREDENTIAL_BYTES = 1_024;

export function brokerCredentialEnvironment(): NodeJS.ProcessEnv {
  return { [BROKER_CREDENTIAL_FD_ENV]: String(BROKER_CREDENTIAL_FD) };
}

export function serializeBrokerCredentials(credentials: BrokerCredentials): string {
  return JSON.stringify(credentials);
}

export function captureBrokerCredentials(
  readCredentials: () => string = readCredentialPipe,
): BrokerCredentials | undefined {
  const descriptor = process.env[BROKER_CREDENTIAL_FD_ENV];
  delete process.env[BROKER_CREDENTIAL_FD_ENV];
  if (descriptor === undefined) return undefined;
  if (descriptor !== String(BROKER_CREDENTIAL_FD)) {
    throw new Error("Invalid pi-subagents broker credential descriptor.");
  }
  let serialized: string;
  try {
    serialized = readCredentials();
  } catch {
    throw new Error("Unable to read pi-subagents broker credentials.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw new Error("Invalid pi-subagents broker credentials.");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid pi-subagents broker credentials.");
  }
  if (!isBrokerCredentials(value)) {
    throw new Error("Invalid pi-subagents broker credentials.");
  }
  return value;
}

function readCredentialPipe(): string {
  try {
    return fs.readFileSync(BROKER_CREDENTIAL_FD, "utf8");
  } finally {
    try {
      fs.closeSync(BROKER_CREDENTIAL_FD);
    } catch {
      // The descriptor may already be closed after a failed read.
    }
  }
}

function isBrokerCredentials(value: unknown): value is BrokerCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    candidate.host === "127.0.0.1" &&
    Number.isSafeInteger(candidate.port) &&
    (candidate.port as number) >= 1 &&
    (candidate.port as number) <= 65_535 &&
    typeof candidate.token === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.token)
  );
}
