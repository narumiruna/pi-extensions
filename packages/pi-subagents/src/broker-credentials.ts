import * as fs from "node:fs";
import type { BrokerCredentials } from "./types.js";

export const BROKER_CREDENTIAL_FD = 3;
export const BROKER_CREDENTIAL_FD_ENV = "PI_SUBAGENT_BROKER_FD";
export const CHILD_READINESS_FD = 4;
export const CHILD_READINESS_FD_ENV = "PI_SUBAGENT_READINESS_FD";
export const MAX_READINESS_FRAME_BYTES = 16 * 1024;

const MAX_BOOTSTRAP_BYTES = 16 * 1024;
const MAX_EXPECTED_TOOLS = 66;
const MAX_TOOL_NAME_LENGTH = 128;
const READINESS_STATE_KEY = Symbol.for("@narumitw/pi-subagents/child-readiness");

export interface ChildBootstrap {
  communication: BrokerCredentials;
  expectedTools: string[];
}

export interface CapturedChildBootstrap extends ChildBootstrap {
  readinessFd?: number;
}

export function childBootstrapEnvironment(expectReadiness: boolean): NodeJS.ProcessEnv {
  return {
    [BROKER_CREDENTIAL_FD_ENV]: String(BROKER_CREDENTIAL_FD),
    ...(expectReadiness ? { [CHILD_READINESS_FD_ENV]: String(CHILD_READINESS_FD) } : {}),
  };
}

export function serializeChildBootstrap(bootstrap: ChildBootstrap): string {
  return JSON.stringify(bootstrap);
}

export function assertChildBootstrapCapacity(expectedTools: string[]): void {
  const serialized = serializeChildBootstrap({
    communication: { host: "127.0.0.1", port: 65_535, token: "f".repeat(64) },
    expectedTools,
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_BOOTSTRAP_BYTES) {
    throw new Error(`Subagent selected tool names exceed the ${MAX_BOOTSTRAP_BYTES}-byte child bootstrap size limit.`);
  }
}

export function captureChildBootstrap(
  readBootstrap: () => string = readBootstrapPipe,
): CapturedChildBootstrap | undefined {
  const credentialDescriptor = process.env[BROKER_CREDENTIAL_FD_ENV];
  const readinessDescriptor = process.env[CHILD_READINESS_FD_ENV];
  delete process.env[BROKER_CREDENTIAL_FD_ENV];
  delete process.env[CHILD_READINESS_FD_ENV];
  setCapturedReadiness(undefined);
  if (credentialDescriptor === undefined) {
    if (readinessDescriptor !== undefined) throw new Error("Unexpected pi-subagents readiness descriptor.");
    return undefined;
  }
  if (credentialDescriptor !== String(BROKER_CREDENTIAL_FD)) {
    throw new Error("Invalid pi-subagents broker credential descriptor.");
  }
  let serialized: string;
  try {
    serialized = readBootstrap();
  } catch {
    throw new Error("Unable to read pi-subagents child bootstrap.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_BOOTSTRAP_BYTES) {
    throw new Error("Invalid pi-subagents child bootstrap.");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid pi-subagents child bootstrap.");
  }
  if (!isChildBootstrap(value)) throw new Error("Invalid pi-subagents child bootstrap.");

  if (value.expectedTools.length > 0) {
    if (readinessDescriptor !== String(CHILD_READINESS_FD)) {
      throw new Error("Invalid pi-subagents readiness descriptor.");
    }
    setCapturedReadiness({ fd: CHILD_READINESS_FD, expectedTools: [...value.expectedTools] });
    return { ...value, readinessFd: CHILD_READINESS_FD };
  }
  if (readinessDescriptor !== undefined) throw new Error("Unexpected pi-subagents readiness descriptor.");
  setCapturedReadiness(undefined);
  return value;
}

export function takeCapturedReadiness(): { fd: number; expectedTools: string[] } | undefined {
  const store = globalThis as unknown as Record<symbol, { fd: number; expectedTools: string[] } | undefined>;
  const readiness = store[READINESS_STATE_KEY];
  delete store[READINESS_STATE_KEY];
  return readiness ? { fd: readiness.fd, expectedTools: [...readiness.expectedTools] } : undefined;
}

function setCapturedReadiness(readiness: { fd: number; expectedTools: string[] } | undefined): void {
  const store = globalThis as unknown as Record<symbol, { fd: number; expectedTools: string[] } | undefined>;
  if (readiness) store[READINESS_STATE_KEY] = readiness;
  else delete store[READINESS_STATE_KEY];
}

function readBootstrapPipe(): string {
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

function isChildBootstrap(value: unknown): value is ChildBootstrap {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  if (!isBrokerCredentials(value.communication)) return false;
  if (!Array.isArray(value.expectedTools) || value.expectedTools.length > MAX_EXPECTED_TOOLS) return false;
  return value.expectedTools.every(
    (tool) =>
      typeof tool === "string" &&
      tool.length > 0 &&
      tool.length <= MAX_TOOL_NAME_LENGTH &&
      !tool.includes(",") &&
      !hasControlCharacter(tool),
  );
}

function isBrokerCredentials(value: unknown): value is BrokerCredentials {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false;
  return (
    value.host === "127.0.0.1" &&
    Number.isSafeInteger(value.port) &&
    (value.port as number) >= 1 &&
    (value.port as number) <= 65_535 &&
    typeof value.token === "string" &&
    /^[a-f0-9]{64}$/u.test(value.token)
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
