import type { ConnectedHcRequest } from "./hc-rpc.mjs";

export const MAX_TASK_BYTES: number;
export const MAX_OUTPUT_BYTES: number;
export const SEND_TIMEOUT_MS: number;

export interface HcIdentity {
  address: string;
  created: number;
  pid: number;
  argv: string[];
}

export function terminalAddress(value: unknown): value is string;
export function identity(value: unknown): HcIdentity;
export function reportedPi(value: unknown, states: string[]): void;
export function coreIdentity(value: unknown): string;
export function checkPeerText(value: unknown): void;
export function validateSend(value: unknown): void;

export class SpawnHcPeerError extends Error {
  details: { error: string; address?: string; submissionAttempted: boolean };
}

export function spawnHcPeer(
  options: { name: string; text: string; piCli: string | undefined },
  dependencies: {
    originId: string;
    cwd: string;
    request: ConnectedHcRequest;
    signal: AbortSignal;
    root: string;
    skill: string;
    approve(details: { core: string; name: string; origin: string }): Promise<boolean>;
  },
): Promise<{ address: string; originAddress: string; name: string; submitted: true; started?: boolean }>;
