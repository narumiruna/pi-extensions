import type { Message, MessageBus } from "dbus-native";

export const SCREENSAVER_BUS_NAME = "org.freedesktop.ScreenSaver";
export const SCREENSAVER_INTERFACE = "org.freedesktop.ScreenSaver";
export const INHIBIT_REASON = "Pi agent is running";

const INHIBIT_APPLICATION_NAME = "pi-caffeinate";
const SCREENSAVER_OBJECT_PATHS = ["/org/freedesktop/ScreenSaver", "/ScreenSaver"];
const DBUS_CALL_TIMEOUT_MS = 2_000;

type DbusFailureHandler = (error: Error) => void;

export interface DbusScreenSaverClient {
  setFailureHandler(handler: DbusFailureHandler | undefined): void;
  inhibit(reason: string, signal?: AbortSignal): Promise<void>;
  uninhibit(): Promise<void>;
  close(): Promise<void>;
}

export type DbusScreenSaverFactory = () => Promise<DbusScreenSaverClient>;

export async function defaultDbusScreenSaverFactory(): Promise<DbusScreenSaverClient> {
  const { sessionBus } = await import("dbus-native");
  return new NativeScreenSaverClient(sessionBus());
}

class NativeScreenSaverClient implements DbusScreenSaverClient {
  private cookie?: number;
  private objectPath?: string;
  private failureHandler?: DbusFailureHandler;
  private pendingFailure?: Error;
  private lastConnectionError?: Error;
  private closing = false;

  private readonly handleConnectionError = (error: unknown) => {
    this.lastConnectionError = toError(error, "D-Bus session connection failed");
    if (this.cookie !== undefined) this.reportFailure(this.lastConnectionError);
  };

  private readonly handleConnectionClose = (error?: unknown) => {
    if (this.closing || this.cookie === undefined) return;
    this.reportFailure(toError(error, this.lastConnectionError?.message ?? "D-Bus session connection closed"));
  };

  constructor(private readonly bus: MessageBus) {
    this.bus.connection.on("error", this.handleConnectionError);
    this.bus.connection.on("close", this.handleConnectionClose);
  }

  setFailureHandler(handler: DbusFailureHandler | undefined): void {
    this.failureHandler = handler;
    if (!handler || !this.pendingFailure) return;
    const failure = this.pendingFailure;
    this.pendingFailure = undefined;
    handler(failure);
  }

  async inhibit(reason: string, signal?: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (const objectPath of SCREENSAVER_OBJECT_PATHS) {
      if (signal?.aborted) throw abortReason(signal);
      try {
        this.cookie = await invoke<number>(
          this.bus,
          {
            destination: SCREENSAVER_BUS_NAME,
            path: objectPath,
            interface: SCREENSAVER_INTERFACE,
            member: "Inhibit",
            signature: "ss",
            body: [INHIBIT_APPLICATION_NAME, reason],
          },
          signal,
        );
        this.objectPath = objectPath;
        return;
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        lastError = error;
      }
    }
    throw new Error(`D-Bus idle inhibit failed: ${formatError(lastError)}`, {
      cause: lastError,
    });
  }

  async uninhibit(): Promise<void> {
    if (this.cookie === undefined || !this.objectPath) return;
    const cookie = this.cookie;
    this.cookie = undefined;
    const objectPath = this.objectPath;
    this.objectPath = undefined;
    await invoke<void>(this.bus, {
      destination: SCREENSAVER_BUS_NAME,
      path: objectPath,
      interface: SCREENSAVER_INTERFACE,
      member: "UnInhibit",
      signature: "u",
      body: [cookie],
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.cookie = undefined;
    this.objectPath = undefined;
    this.failureHandler = undefined;
    try {
      await this.bus.close();
    } finally {
      this.bus.connection.off("error", this.handleConnectionError);
      this.bus.connection.off("close", this.handleConnectionClose);
    }
  }

  private reportFailure(error: Error): void {
    if (this.cookie === undefined) return;
    this.cookie = undefined;
    this.objectPath = undefined;
    if (this.failureHandler) this.failureHandler(error);
    else this.pendingFailure = error;
  }
}

function invoke<TResult>(bus: MessageBus, message: Message, signal?: AbortSignal): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    bus.invoke(message, { signal, timeout: DBUS_CALL_TIMEOUT_MS }, (error, ...values) => {
      if (error) reject(error);
      else resolve(values[0] as TResult);
    });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("D-Bus idle inhibit cancelled", "AbortError");
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
  }
  return String(error);
}
