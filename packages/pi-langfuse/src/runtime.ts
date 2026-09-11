import { createHash } from "node:crypto";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  type LangfuseObservation,
  type LangfuseObservationAttributes,
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
} from "@langfuse/tracing";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LangfuseConfig } from "./config.js";
import type { Observation, ObservationAttributes, ObservationType, TraceBackend } from "./tracing.js";

const RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v1");

interface SharedRuntime {
  fingerprint: string;
  backend: ProductionTraceBackend;
  shutdown: boolean;
}

type GlobalWithRuntime = typeof globalThis & {
  [RUNTIME_KEY]?: Promise<SharedRuntime>;
};

export interface RuntimeFactories {
  createProcessor(config: LangfuseConfig): SpanProcessor;
  createProvider(processor: SpanProcessor): NodeTracerProvider;
  selectProvider(provider: NodeTracerProvider): void;
}

class ProductionObservation implements Observation {
  constructor(readonly native: LangfuseObservation) {}

  update(attributes: ObservationAttributes): Observation {
    const { sessionId, userId, ...observationAttributes } = attributes;
    this.native.updateOtelSpanAttributes(observationAttributes as LangfuseObservationAttributes);
    applySessionId(this.native, sessionId);
    applyUserId(this.native, userId);
    return this;
  }

  updateTrace(attributes: ObservationAttributes): Observation {
    const { input, output, metadata, name, sessionId, userId, tags, version } = attributes;
    if (input !== undefined || output !== undefined) {
      this.native.setTraceIO({ input, output });
    }
    if (name !== undefined) {
      this.native.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, name);
    }
    applySessionId(this.native, sessionId);
    applyUserId(this.native, userId);
    if (tags !== undefined) {
      this.native.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, tags);
    }
    if (version !== undefined) {
      this.native.otelSpan.setAttribute(LangfuseOtelSpanAttributes.VERSION, version);
    }
    for (const [key, value] of Object.entries(metadata ?? {})) {
      this.native.otelSpan.setAttribute(`${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`, String(value));
    }
    return this;
  }

  end(endTime?: number): Observation {
    this.native.end(endTime);
    return this;
  }
}

class ProductionTraceBackend implements TraceBackend {
  constructor(
    private readonly provider: NodeTracerProvider,
    private readonly processor: SpanProcessor,
  ) {}

  start(
    name: string,
    attributes: ObservationAttributes,
    options: { asType: ObservationType; parent?: Observation },
  ): Observation {
    const { sessionId, userId, ...observationAttributes } = attributes;
    const parent = options.parent;
    const native =
      parent instanceof ProductionObservation
        ? startChild(parent.native, name, observationAttributes, options.asType)
        : startRoot(name, observationAttributes, options.asType);
    applySessionId(native, sessionId);
    applyUserId(native, userId);
    return new ProductionObservation(native);
  }

  async forceFlush(): Promise<void> {
    await this.processor.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}

export async function createProductionBackend(
  config: LangfuseConfig,
  factoryOverrides: Partial<RuntimeFactories> = {},
): Promise<TraceBackend> {
  const globalRuntime = globalThis as GlobalWithRuntime;
  const fingerprint = configFingerprint(config);
  const existing = globalRuntime[RUNTIME_KEY];
  if (existing) {
    const runtime = await existing;
    if (runtime.shutdown) {
      throw new Error("Langfuse tracing was already shut down; restart Pi to enable it again.");
    }
    if (runtime.fingerprint !== fingerprint) {
      throw new Error("Langfuse configuration changed; restart Pi to apply the new credentials.");
    }
    return runtime.backend;
  }

  const factories = { ...defaultFactories, ...factoryOverrides };
  const initializing = initializeRuntime(config, fingerprint, factories);
  globalRuntime[RUNTIME_KEY] = initializing;
  try {
    return (await initializing).backend;
  } catch (error) {
    delete globalRuntime[RUNTIME_KEY];
    throw error;
  }
}

async function initializeRuntime(
  config: LangfuseConfig,
  fingerprint: string,
  factories: RuntimeFactories,
): Promise<SharedRuntime> {
  const processor = factories.createProcessor(config);
  let provider: NodeTracerProvider | undefined;
  try {
    provider = factories.createProvider(processor);
    factories.selectProvider(provider);
  } catch (error) {
    await (provider?.shutdown() ?? processor.shutdown()).catch(() => undefined);
    throw error;
  }
  const backend = new ProductionTraceBackend(provider, processor);
  const runtime: SharedRuntime = { fingerprint, backend, shutdown: false };
  const originalShutdown = backend.shutdown.bind(backend);
  backend.shutdown = async () => {
    if (runtime.shutdown) return;
    runtime.shutdown = true;
    await originalShutdown();
  };
  return runtime;
}

const defaultFactories: RuntimeFactories = {
  createProcessor: (config) => {
    const secrets = [config.secretKey, config.publicKey];
    return new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      environment: config.environment ?? "",
      release: config.release ?? "",
      flushAt: 512,
      flushInterval: 5,
      timeout: 5,
      mask: ({ data }) => maskSecrets(data, secrets),
      shouldExportSpan: ({ otelSpan }) => typeof otelSpan.attributes["langfuse.observation.type"] === "string",
    });
  },
  createProvider: (processor) => new NodeTracerProvider({ spanProcessors: [processor] }),
  selectProvider: setLangfuseTracerProvider,
};

function applySessionId(observation: LangfuseObservation, sessionId: string | undefined): void {
  if (sessionId !== undefined) {
    observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, sessionId);
  }
}

function applyUserId(observation: LangfuseObservation, userId: string | undefined): void {
  if (userId !== undefined) {
    observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, userId);
  }
}

function startRoot(name: string, attributes: ObservationAttributes, type: ObservationType): LangfuseObservation {
  if (type === "agent") {
    return startObservation(name, attributes as LangfuseObservationAttributes, { asType: "agent" });
  }
  if (type === "generation") {
    return startObservation(name, attributes as LangfuseObservationAttributes, {
      asType: "generation",
    });
  }
  if (type === "tool") {
    return startObservation(name, attributes as LangfuseObservationAttributes, { asType: "tool" });
  }
  return startObservation(name, attributes as LangfuseObservationAttributes, { asType: "span" });
}

function startChild(
  parent: LangfuseObservation,
  name: string,
  attributes: ObservationAttributes,
  type: ObservationType,
): LangfuseObservation {
  if (type === "agent") {
    return parent.startObservation(name, attributes as LangfuseObservationAttributes, {
      asType: "agent",
    });
  }
  if (type === "generation") {
    return parent.startObservation(name, attributes as LangfuseObservationAttributes, {
      asType: "generation",
    });
  }
  if (type === "tool") {
    return parent.startObservation(name, attributes as LangfuseObservationAttributes, {
      asType: "tool",
    });
  }
  return parent.startObservation(name, attributes as LangfuseObservationAttributes, {
    asType: "span",
  });
}

function configFingerprint(config: LangfuseConfig): string {
  return createHash("sha256")
    .update(
      `${config.publicKey}\0${config.secretKey}\0${config.baseUrl}\0${config.environment ?? ""}\0${config.release ?? ""}`,
    )
    .digest("hex");
}

export function maskSecrets(data: unknown, secrets: readonly string[]): unknown {
  return maskSecretValue(data, secrets, new WeakSet<object>());
}

function maskSecretValue(data: unknown, secrets: readonly string[], active: WeakSet<object>): unknown {
  if (typeof data === "string") {
    let masked = data.replace(/\b(?:sk|pk)-lf-[A-Za-z0-9_-]+\b/g, "[LANGFUSE_KEY_REDACTED]");
    for (const secret of secrets) {
      if (secret) masked = masked.replaceAll(secret, "[LANGFUSE_KEY_REDACTED]");
    }
    return masked;
  }
  if (!data || typeof data !== "object") return data;
  if (active.has(data)) return "[circular]";

  active.add(data);
  try {
    if (Array.isArray(data)) {
      return data.map((item) => maskSecretValue(item, secrets, active));
    }
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, maskSecretValue(value, secrets, active)]),
    );
  } finally {
    active.delete(data);
  }
}
