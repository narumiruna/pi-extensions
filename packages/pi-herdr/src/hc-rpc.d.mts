export const HC_MAX_FRAME_BYTES: number;

export interface HcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HcSubscription {
  snapshot: unknown;
  closed: Promise<Error | undefined>;
  close(): Promise<void>;
}

export function requestHc(
  endpoint: string,
  method: string,
  params?: Record<string, unknown>,
  options?: HcRequestOptions,
): Promise<unknown>;

export type ConnectedHcRequest = (
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

export function withHcConnection<T>(
  endpoint: string,
  operation: (request: ConnectedHcRequest, disconnected: AbortSignal) => Promise<T>,
  options?: Pick<HcRequestOptions, "signal" | "maxBytes">,
): Promise<T>;

export function subscribeHc(
  endpoint: string,
  options?: HcRequestOptions & { onEvent?: (frame: unknown) => void },
): Promise<HcSubscription>;
