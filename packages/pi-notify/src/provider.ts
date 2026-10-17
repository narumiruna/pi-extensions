export interface TelegramDestination {
  provider: "telegram";
  label: string;
  botToken: string;
  chatId: string;
  messageThreadId?: number;
}

export interface GotifyDestination {
  provider: "gotify";
  label: string;
  serverUrl: string;
  appToken: string;
  priority?: number;
}

export type Destination = TelegramDestination | GotifyDestination;

export interface BodyEmphasis {
  style: "bold" | "monospace";
  /** Offset and length in UTF-16 code units of the sanitized body. */
  offset: number;
  length: number;
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  bodyEmphasis?: BodyEmphasis[];
  settledAt: number;
}

export type DeliveryCode =
  | "invalid-destination"
  | "unsupported-provider"
  | "network"
  | "timeout"
  | "http"
  | "api"
  | "rate-limit"
  | "response"
  | "cancelled";
export type DeliveryResult =
  | { state: "accepted" }
  | { state: "failed"; code: DeliveryCode; retryAfterSeconds?: number }
  | { state: "cancelled"; code: "cancelled" };

export interface NotificationProvider {
  readonly id: string;
  readonly label: string;
  /** Return all owned fields, using undefined for absent optional fields, or reject. */
  validate(value: unknown): Destination | undefined;
  send(destination: Destination, notification: Notification, signal: AbortSignal): Promise<DeliveryResult>;
}

export type Providers = ReadonlyMap<string, NotificationProvider>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Unknown providers never fall back to Telegram. Raw settings remain storage-owned. */
export function validateDestination(value: unknown, providers: Providers): Destination | undefined {
  if (!isObject(value) || typeof value.provider !== "string") return undefined;
  return providers.get(value.provider)?.validate(value);
}

export async function deliver(
  providers: Providers,
  destination: Destination,
  notification: Notification,
  signal: AbortSignal,
): Promise<DeliveryResult> {
  if (signal.aborted) return { state: "cancelled", code: "cancelled" };
  const provider = providers.get(destination.provider);
  if (!provider) return { state: "failed", code: "unsupported-provider" };
  if (!provider.validate(destination)) return { state: "failed", code: "invalid-destination" };
  try {
    return await provider.send(destination, notification, signal);
  } catch {
    return signal.aborted ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "network" };
  }
}
