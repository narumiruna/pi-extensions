import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { context, ROOT_CONTEXT, type Span, type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { BatchSpanProcessor, type ReadableSpan, type SpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { LangfuseConfig } from "./config.js";
import {
  type CreateLangfuseRuntimeOptions,
  createLangfuseRuntimeFromBackend,
  getLangfuseRuntimeInternal,
  type LangfuseRuntime,
  type LangfuseRuntimeInternal,
} from "./runtime-core.js";
import { DEFAULT_BASE_URL } from "./runtime-defaults.js";
import type { Observation, ObservationAttributes, ObservationType, TraceBackend } from "./tracing.js";

export type {
  CreateLangfuseRuntimeOptions,
  LangfuseRuntime,
  LangfuseRuntimeConfig,
} from "./runtime-core.js";

const RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v2");
const LEGACY_RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v1");
const INSTRUMENTATION_SCOPE = "@narumitw/pi-langfuse";
const TRACE = "langfuse.trace";
const OBSERVATION = "langfuse.observation";

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

interface RuntimeFactories {
  createProcessor(config: ResolvedRuntimeConfig): SpanProcessor;
  createProvider(processor: SpanProcessor): TracerProvider;
}

class ProductionObservation implements Observation {
  readonly traceId: string;

  constructor(
    readonly span: Span,
    private readonly secrets: readonly string[],
  ) {
    this.traceId = span.spanContext().traceId;
  }

  update(attributes: ObservationAttributes): Observation {
    const {
      input,
      output,
      metadata,
      level,
      statusMessage,
      model,
      modelParameters,
      usageDetails,
      costDetails,
      completionStartTime,
      version,
      sessionId,
      userId,
    } = attributes;
    this.span.setAttributes({
      [`${OBSERVATION}.input`]: serializeIO(input, this.secrets),
      [`${OBSERVATION}.output`]: serializeIO(output, this.secrets),
      [`${OBSERVATION}.level`]: level,
      [`${OBSERVATION}.status_message`]: this.mask(statusMessage),
      [`${OBSERVATION}.model.name`]: this.mask(model),
      [`${OBSERVATION}.model.parameters`]: serializeIO(modelParameters, this.secrets),
      [`${OBSERVATION}.usage_details`]: serializeIO(usageDetails, this.secrets),
      [`${OBSERVATION}.cost_details`]: serializeIO(costDetails, this.secrets),
      [`${OBSERVATION}.completion_start_time`]: serializeIO(completionStartTime, this.secrets),
      "langfuse.version": this.mask(version),
      "session.id": this.mask(sessionId),
      "user.id": this.mask(userId),
    });
    this.setMetadata(OBSERVATION, metadata);
    return this;
  }

  updateTrace(attributes: ObservationAttributes): Observation {
    const { input, output, metadata, name, sessionId, userId, tags, version } = attributes;
    // Trace IO belongs to the receiving span without changing its observation IO.
    this.span.setAttributes({
      [`${TRACE}.input`]: serializeIO(input, this.secrets),
      [`${TRACE}.output`]: serializeIO(output, this.secrets),
      [`${TRACE}.name`]: this.mask(name),
      [`${TRACE}.tags`]: tags?.map((tag) => maskSecretString(tag, this.secrets)),
      "langfuse.version": this.mask(version),
      "session.id": this.mask(sessionId),
      "user.id": this.mask(userId),
    });
    this.setMetadata(TRACE, metadata);
    return this;
  }

  end(endTime?: number): Observation {
    this.span.end(endTime);
    return this;
  }

  private mask(value: string | undefined): string | undefined {
    return value === undefined ? undefined : maskSecretString(value, this.secrets);
  }

  private setMetadata(scope: string, metadata: Record<string, unknown> | undefined): void {
    for (const [key, value] of Object.entries(metadata ?? {})) {
      if (scope === OBSERVATION && value == null) continue;
      const serialized = serializeMetadataValue(value, this.secrets);
      if (serialized !== undefined) {
        this.span.setAttribute(`${scope}.metadata.${maskSecretString(key, this.secrets)}`, serialized);
      }
    }
  }
}

class ProductionTraceBackend implements TraceBackend {
  private readonly tracer: Tracer;
  private readonly spans = new WeakSet<Span>();
  private readonly secrets: readonly string[];

  constructor(
    private readonly provider: TracerProvider,
    private readonly processor: SpanProcessor,
    private readonly config: ResolvedRuntimeConfig,
  ) {
    this.tracer = provider.getTracer(INSTRUMENTATION_SCOPE);
    this.secrets = [config.publicKey, config.secretKey].sort((a, b) => b.length - a.length);
  }

  start(
    name: string,
    attributes: ObservationAttributes,
    options: { asType: ObservationType; parent?: Observation; startTime?: Date },
  ): Observation {
    const parent = options.parent instanceof ProductionObservation ? options.parent.span : undefined;
    const parentContext = parent ? trace.setSpan(ROOT_CONTEXT, parent) : context.active();
    const parentSpan = trace.getSpan(parentContext);
    // Preserve the trace ID of an explicit parent even if it ended before this span started.
    const isAppRoot = !parentSpan || !this.spans.has(parentSpan) || !parentSpan.isRecording();
    const span = this.tracer.startSpan(
      maskSecretString(name, this.secrets),
      {
        startTime: options.startTime,
        attributes: {
          [`${OBSERVATION}.type`]: options.asType,
          "langfuse.internal.is_app_root": isAppRoot ? true : undefined,
          "langfuse.environment": this.config.environment && maskSecretString(this.config.environment, this.secrets),
          "langfuse.release": this.config.release && maskSecretString(this.config.release, this.secrets),
        },
      },
      parentContext,
    );
    this.spans.add(span);
    return new ProductionObservation(span, this.secrets).update(attributes);
  }

  forceFlush(): Promise<void> {
    return this.processor.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.provider.shutdown();
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
  let provider: TracerProvider;
  try {
    provider = factories.createProvider(processor);
  } catch (error) {
    await processor.shutdown().catch(() => undefined);
    throw error;
  }
  const runtime = getLangfuseRuntimeInternal(
    createLangfuseRuntimeFromBackend(new ProductionTraceBackend(provider, processor, config)),
  );
  return { fingerprint, runtime, shutdown: true };
}

class PiBatchSpanProcessor extends BatchSpanProcessor {
  override onEnd(span: ReadableSpan): void {
    if (span.instrumentationScope.name === INSTRUMENTATION_SCOPE) super.onEnd(span);
  }
}

const defaultFactories: RuntimeFactories = {
  createProcessor: (config) =>
    new PiBatchSpanProcessor({
      exporter: new OTLPTraceExporter({
        url: `${config.baseUrl}/api/public/otel/v1/traces`,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
          "x-langfuse-ingestion-version": "4",
        },
        timeoutMillis: 5_000,
        compression: resolveCompression(),
      }),
      // Keep batches smaller than the SDK default because each span can carry large captured inputs and outputs.
      maxExportBatchSize: 128,
      scheduledDelayMillis: 5_000,
    }),
  // The provider is private: do not register it with OpenTelemetry or replace the host's provider.
  createProvider: (processor) => new TracerProvider({ spanProcessors: [processor] }),
};

function resolveCompression(): CompressionAlgorithm {
  for (const key of [
    "LANGFUSE_OTEL_COMPRESSION",
    "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION",
    "OTEL_EXPORTER_OTLP_COMPRESSION",
  ]) {
    const value = process.env[key]?.trim().toLowerCase();
    if (value === CompressionAlgorithm.NONE || value === CompressionAlgorithm.GZIP) return value;
  }
  return CompressionAlgorithm.GZIP;
}

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

function serializeIO(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value === "string") return maskSecretString(value, secrets);
  if (value == null) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    // Mask decoded keys and values so escaped credentials are redacted without breaking JSON.
    return JSON.stringify(maskSecrets(JSON.parse(serialized), secrets));
  } catch {
    return "<failed to serialize>";
  }
}

function serializeMetadataValue(value: unknown, secrets: readonly string[]): string | undefined {
  try {
    return JSON.stringify(maskSecrets(value, secrets), (_, entry: unknown) => {
      if (typeof entry === "number" && !Number.isFinite(entry)) return String(entry);
      if (typeof entry !== "bigint") return entry;
      return entry >= BigInt(Number.MIN_SAFE_INTEGER) && entry <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(entry)
        : entry.toString();
    });
  } catch {
    return JSON.stringify("<failed to serialize>");
  }
}

function maskSecretString(value: string, secrets: readonly string[]): string {
  let masked = value.replace(/\b(?:sk|pk)-lf-[A-Za-z0-9_-]+\b/gu, "[LANGFUSE_KEY_REDACTED]");
  // Replace longer configured keys first if one key is a prefix of the other.
  for (const secret of secrets) {
    if (secret) masked = masked.replaceAll(secret, "[LANGFUSE_KEY_REDACTED]");
  }
  return masked;
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
  if (typeof data === "string") return maskSecretString(data, secrets);
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
