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
import { DEFAULT_BASE_URL, type LangfuseConfig } from "./config.js";
import {
  type CreateLangfuseRuntimeOptions,
  createLangfuseRuntimeFromBackend,
  getLangfuseRuntimeInternal,
  type LangfuseRuntime,
  type LangfuseRuntimeInternal,
} from "./runtime-core.js";
import type { Observation, ObservationAttributes, ObservationType, TraceBackend } from "./tracing.js";

export type {
  CreateLangfuseRuntimeOptions,
  LangfuseRuntime,
  LangfuseRuntimeConfig,
} from "./runtime-core.js";

const RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v2");
const LEGACY_RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v1");

interface ResolvedRuntimeConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
}

interface SharedRuntime {
  fingerprint: string;
  runtime: LangfuseRuntimeInternal;
  shutdown: true;
}

type GlobalWithRuntime = typeof globalThis & {
  [RUNTIME_KEY]?: Promise<SharedRuntime>;
  [LEGACY_RUNTIME_KEY]?: unknown;
};

export interface RuntimeFactories {
  createProcessor(config: ResolvedRuntimeConfig): SpanProcessor;
  createProvider(processor: SpanProcessor): NodeTracerProvider;
  selectProvider(provider: NodeTracerProvider): void;
}

class ProductionObservation implements Observation {
  readonly traceId: string;

  constructor(
    readonly native: LangfuseObservation,
    private readonly secrets: readonly string[],
  ) {
    this.traceId = native.traceId;
  }

  update(attributes: ObservationAttributes): Observation {
    const { sessionId, userId, ...observationAttributes } = maskObservationAttributes(attributes, this.secrets);
    this.native.updateOtelSpanAttributes(observationAttributes as LangfuseObservationAttributes);
    applySessionId(this.native, sessionId);
    applyUserId(this.native, userId);
    return this;
  }

  updateTrace(attributes: ObservationAttributes): Observation {
    const { input, output, metadata, name, sessionId, userId, tags, version } = maskObservationAttributes(
      attributes,
      this.secrets,
    );
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
      const serialized = serializeMetadataValue(value);
      if (serialized !== undefined) {
        this.native.otelSpan.setAttribute(`${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`, serialized);
      }
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
    private readonly secrets: readonly string[],
  ) {}

  start(
    name: string,
    attributes: ObservationAttributes,
    options: { asType: ObservationType; parent?: Observation; startTime?: Date },
  ): Observation {
    const maskedName = maskSecretString(name, this.secrets);
    const { sessionId, userId, ...observationAttributes } = maskObservationAttributes(attributes, this.secrets);
    const parent = options.parent;
    const native =
      parent instanceof ProductionObservation
        ? startChild(parent.native, maskedName, observationAttributes, options.asType, options.startTime)
        : startRoot(maskedName, observationAttributes, options.asType, options.startTime);
    applySessionId(native, sessionId);
    applyUserId(native, userId);
    return new ProductionObservation(native, this.secrets);
  }

  async forceFlush(): Promise<void> {
    await this.processor.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}

export async function createLangfuseRuntime(options: CreateLangfuseRuntimeOptions = {}): Promise<LangfuseRuntime> {
  return createSharedRuntime(resolveLangfuseRuntimeConfig(options), defaultFactories);
}

export async function createProductionBackend(
  config: LangfuseConfig,
  factoryOverrides: Partial<RuntimeFactories> = {},
): Promise<TraceBackend> {
  const runtime = await createSharedRuntime(resolveLangfuseRuntimeConfig({ config, env: false }), {
    ...defaultFactories,
    ...factoryOverrides,
  });
  return getLangfuseRuntimeInternal(runtime).backend;
}

async function createSharedRuntime(
  config: ResolvedRuntimeConfig,
  factories: RuntimeFactories,
): Promise<LangfuseRuntime> {
  const globalRuntime = globalThis as GlobalWithRuntime;
  const fingerprint = configFingerprint(config);
  const existing = globalRuntime[RUNTIME_KEY];
  const legacyRuntime = globalRuntime[LEGACY_RUNTIME_KEY];
  if (legacyRuntime !== undefined && legacyRuntime !== existing) {
    throw new Error("An older Langfuse runtime is already loaded; restart the process before enabling this version.");
  }
  if (existing) {
    if (legacyRuntime === undefined) globalRuntime[LEGACY_RUNTIME_KEY] = existing;
    const shared = await existing;
    if (shared.runtime.closed) {
      throw new Error("Langfuse tracing was already shut down; restart the process to enable it again.");
    }
    if (shared.fingerprint !== fingerprint) {
      throw new Error("Langfuse configuration changed; restart the process to apply the new credentials.");
    }
    return shared.runtime;
  }

  const initializing = initializeRuntime(config, fingerprint, factories);
  globalRuntime[RUNTIME_KEY] = initializing;
  globalRuntime[LEGACY_RUNTIME_KEY] = initializing;
  try {
    return (await initializing).runtime;
  } catch (error) {
    if (globalRuntime[RUNTIME_KEY] === initializing) delete globalRuntime[RUNTIME_KEY];
    if (globalRuntime[LEGACY_RUNTIME_KEY] === initializing) delete globalRuntime[LEGACY_RUNTIME_KEY];
    throw error;
  }
}

async function initializeRuntime(
  config: ResolvedRuntimeConfig,
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
  const runtime = getLangfuseRuntimeInternal(
    createLangfuseRuntimeFromBackend(
      new ProductionTraceBackend(provider, processor, [config.publicKey, config.secretKey]),
    ),
  );
  return { fingerprint, runtime, shutdown: true };
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

export function resolveLangfuseRuntimeConfig(options: CreateLangfuseRuntimeOptions): ResolvedRuntimeConfig {
  const env = options.env === false ? undefined : (options.env ?? process.env);
  const publicKey = requiredSetting("publicKey", options.config?.publicKey, env?.LANGFUSE_PUBLIC_KEY);
  const secretKey = requiredSetting("secretKey", options.config?.secretKey, env?.LANGFUSE_SECRET_KEY);
  const explicitBaseUrl = options.config?.baseUrl;
  if (explicitBaseUrl !== undefined && !normalizeString(explicitBaseUrl)) {
    throw new Error("Langfuse baseUrl must be a non-empty string.");
  }
  const rawBaseUrl = selectedSetting(explicitBaseUrl, env?.LANGFUSE_BASE_URL) ?? DEFAULT_BASE_URL;
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    throw new Error("Langfuse baseUrl must use HTTP or HTTPS without credentials, a query, or a fragment.");
  }
  const environment = optionalSetting("environment", options.config?.environment, env?.LANGFUSE_TRACING_ENVIRONMENT);
  if (environment && (environment.length > 40 || !/^(?!langfuse)[a-z0-9_-]+$/u.test(environment))) {
    throw new Error(
      "Langfuse environment must be at most 40 lowercase letters, numbers, hyphens, or underscores and must not start with langfuse.",
    );
  }
  const release = optionalSetting("release", options.config?.release, env?.LANGFUSE_RELEASE);
  return { publicKey, secretKey, baseUrl, ...(environment ? { environment } : {}), ...(release ? { release } : {}) };
}

function requiredSetting(name: string, explicit: string | undefined, environment: string | undefined): string {
  const value = selectedSetting(explicit, environment);
  if (!value) throw new Error(`Langfuse ${name} is required.`);
  return value;
}

function optionalSetting(
  name: string,
  explicit: string | undefined,
  environment: string | undefined,
): string | undefined {
  const selected = explicit !== undefined ? explicit : environment;
  if (selected === undefined) return undefined;
  const value = normalizeString(selected);
  if (!value) throw new Error(`Langfuse ${name} must be a non-empty string.`);
  return value;
}

function selectedSetting(explicit: string | undefined, environment: string | undefined): string | undefined {
  if (explicit !== undefined) return normalizeString(explicit);
  return normalizeString(environment);
}

function normalizeBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function serializeMetadataValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function maskObservationAttributes(
  attributes: ObservationAttributes,
  secrets: readonly string[],
): ObservationAttributes {
  return {
    ...attributes,
    ...(attributes.metadata ? { metadata: maskSecrets(attributes.metadata, secrets) as Record<string, unknown> } : {}),
    ...(attributes.name ? { name: maskSecretString(attributes.name, secrets) } : {}),
    ...(attributes.sessionId ? { sessionId: maskSecretString(attributes.sessionId, secrets) } : {}),
    ...(attributes.userId ? { userId: maskSecretString(attributes.userId, secrets) } : {}),
    ...(attributes.tags ? { tags: attributes.tags.map((tag) => maskSecretString(tag, secrets)) } : {}),
    ...(attributes.statusMessage ? { statusMessage: maskSecretString(attributes.statusMessage, secrets) } : {}),
    ...(attributes.model ? { model: maskSecretString(attributes.model, secrets) } : {}),
    ...(attributes.version ? { version: maskSecretString(attributes.version, secrets) } : {}),
    ...(attributes.modelParameters
      ? {
          modelParameters: Object.fromEntries(
            Object.entries(attributes.modelParameters).map(([key, value]) => [
              maskSecretString(key, secrets),
              typeof value === "string" ? maskSecretString(value, secrets) : value,
            ]),
          ),
        }
      : {}),
  };
}

function maskSecretString(value: string, secrets: readonly string[]): string {
  return maskSecrets(value, secrets) as string;
}

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

function startRoot(
  name: string,
  attributes: ObservationAttributes,
  type: ObservationType,
  startTime?: Date,
): LangfuseObservation {
  if (type === "agent") {
    return startObservation(name, attributes as LangfuseObservationAttributes, { asType: "agent", startTime });
  }
  if (type === "generation") {
    return startObservation(name, attributes as LangfuseObservationAttributes, {
      asType: "generation",
      startTime,
    });
  }
  if (type === "tool") {
    return startObservation(name, attributes as LangfuseObservationAttributes, { asType: "tool", startTime });
  }
  return startObservation(name, attributes as LangfuseObservationAttributes, { asType: "span", startTime });
}

function startChild(
  parent: LangfuseObservation,
  name: string,
  attributes: ObservationAttributes,
  type: ObservationType,
  startTime?: Date,
): LangfuseObservation {
  if (startTime) {
    const parentSpanContext = parent.otelSpan.spanContext();
    if (type === "agent") {
      return startObservation(name, attributes as LangfuseObservationAttributes, {
        asType: "agent",
        parentSpanContext,
        startTime,
      });
    }
    if (type === "generation") {
      return startObservation(name, attributes as LangfuseObservationAttributes, {
        asType: "generation",
        parentSpanContext,
        startTime,
      });
    }
    if (type === "tool") {
      return startObservation(name, attributes as LangfuseObservationAttributes, {
        asType: "tool",
        parentSpanContext,
        startTime,
      });
    }
    return startObservation(name, attributes as LangfuseObservationAttributes, {
      asType: "span",
      parentSpanContext,
      startTime,
    });
  }
  if (type === "agent") {
    return parent.startObservation(name, attributes as LangfuseObservationAttributes, { asType: "agent" });
  }
  if (type === "generation") {
    return parent.startObservation(name, attributes as LangfuseObservationAttributes, { asType: "generation" });
  }
  if (type === "tool") {
    return parent.startObservation(name, attributes as LangfuseObservationAttributes, { asType: "tool" });
  }
  return parent.startObservation(name, attributes as LangfuseObservationAttributes, { asType: "span" });
}

function configFingerprint(config: ResolvedRuntimeConfig): string {
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
      Object.entries(data).map(([key, value]) => [
        maskSecretString(key, secrets),
        maskSecretValue(value, secrets, active),
      ]),
    );
  } finally {
    active.delete(data);
  }
}
