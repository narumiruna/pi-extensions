import type { TraceBackend } from "./tracing.js";

export interface LangfuseRuntimeConfig {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment?: string;
  release?: string;
}

export interface CreateLangfuseRuntimeOptions {
  config?: LangfuseRuntimeConfig;
  env?: NodeJS.ProcessEnv | false;
}

export interface LangfuseRuntime {
  readonly closed: boolean;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

type RuntimeSessionDisposer = (statusMessage: string) => void | Promise<void>;

export interface LangfuseRuntimeInternal extends LangfuseRuntime {
  readonly backend: TraceBackend;
  registerSession(disposer: RuntimeSessionDisposer): () => void;
}

const RUNTIME_INTERNAL_KEY = Symbol.for("@narumitw/pi-langfuse/runtime-internal/v2");

class ManagedLangfuseRuntime implements LangfuseRuntimeInternal {
  private state: "open" | "closing" | "closed" = "open";
  private readonly sessionDisposers = new Set<RuntimeSessionDisposer>();
  private flushQueue = Promise.resolve();
  private shutdownPromise: Promise<void> | undefined;

  constructor(readonly backend: TraceBackend) {}

  get closed(): boolean {
    return this.state !== "open";
  }

  registerSession(disposer: RuntimeSessionDisposer): () => void {
    if (this.state !== "open") throw new Error("Langfuse runtime is shutting down or already closed.");
    this.sessionDisposers.add(disposer);
    return () => this.sessionDisposers.delete(disposer);
  }

  flush(): Promise<void> {
    if (this.state !== "open") {
      return Promise.reject(new Error("Langfuse runtime is shutting down or already closed."));
    }
    const operation = this.flushQueue.then(() => this.backend.forceFlush());
    this.flushQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.state = "closing";
    this.shutdownPromise = this.shutdownNow();
    return this.shutdownPromise;
  }

  private async shutdownNow(): Promise<void> {
    const errors: unknown[] = [];
    for (const dispose of [...this.sessionDisposers]) {
      try {
        await dispose("Langfuse runtime shut down before the Pi session was disposed.");
      } catch (error) {
        errors.push(error);
      }
    }
    this.sessionDisposers.clear();

    await this.flushQueue;
    try {
      await this.backend.forceFlush();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.backend.shutdown();
    } catch (error) {
      errors.push(error);
    } finally {
      this.state = "closed";
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Langfuse runtime shutdown failed.");
  }
}

export function getLangfuseRuntimeInternal(runtime: LangfuseRuntime): LangfuseRuntimeInternal {
  const internal = (runtime as LangfuseRuntime & { [key: symbol]: LangfuseRuntimeInternal | undefined })[
    RUNTIME_INTERNAL_KEY
  ];
  if (!internal) throw new Error("Langfuse runtime was not created by @narumitw/pi-langfuse.");
  return internal;
}

export function createLangfuseRuntimeFromBackend(backend: TraceBackend): LangfuseRuntime {
  return registerLangfuseRuntime(new ManagedLangfuseRuntime(backend));
}

export function registerLangfuseRuntime(runtime: LangfuseRuntimeInternal): LangfuseRuntimeInternal {
  Object.defineProperty(runtime, RUNTIME_INTERNAL_KEY, { value: runtime });
  return runtime;
}
