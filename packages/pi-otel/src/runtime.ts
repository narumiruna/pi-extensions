import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { context, ROOT_CONTEXT, type Span, SpanKind, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  CompressionAlgorithm,
  getSharedConfigurationDefaults,
  OTLPExporterBase,
} from "@opentelemetry/otlp-exporter-base";
import { createOtlpHttpExportDelegate, httpAgentFactoryFromOptions } from "@opentelemetry/otlp-exporter-base/node-http";
import { ProtobufTraceSerializer, TraceExporterMetricsHelper } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type ReadableSpan, type SpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { LangfuseConfig } from "./config.js";
import { normalizeOtlpConnection, type OtlpConnection, type OtlpRuntimeConfig, otlpSecrets } from "./otlp-settings.js";
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

// Keep the process slots and Langfuse instrumentation scope stable across the package rename.
const RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v2");
const LEGACY_RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v1");
const LANGFUSE_SCOPE = "@narumitw/pi-langfuse";
const OTLP_SCOPE = "@narumitw/pi-otel";
const MAX_PENDING_METADATA_ATTRIBUTES = 128;

interface ResolvedLangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
}

type ResolvedOtlpConfig = OtlpConnection & { backend: "otlp" };
type ResolvedRuntimeConfig = ResolvedLangfuseConfig | ResolvedOtlpConfig;

function isOtlpConfig(config: ResolvedRuntimeConfig): config is ResolvedOtlpConfig {
  return "backend" in config;
}

function instrumentationScope(config: ResolvedRuntimeConfig): string {
  return isOtlpConfig(config) ? OTLP_SCOPE : LANGFUSE_SCOPE;
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
  createProvider(processor: SpanProcessor, config: ResolvedRuntimeConfig): TracerProvider;
}

class ProductionObservation implements Observation {
  readonly traceId: string;
  private readonly metadata = new Map<string, string | number | boolean>();
  private readonly observationScope: string;
  private readonly traceScope: string;

  constructor(
    readonly span: Span,
    private readonly secrets: readonly string[],
    private readonly otlp: boolean,
  ) {
    this.observationScope = otlp ? "pi.observation" : "langfuse.observation";
    this.traceScope = otlp ? "pi.trace" : "langfuse.trace";
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
    const scope = this.observationScope;
    this.span.setAttributes({
      [`${scope}.input`]: serializeIO(input, this.secrets),
      [`${scope}.output`]: serializeIO(output, this.secrets),
      [`${scope}.level`]: level,
      [`${scope}.status_message`]: this.mask(statusMessage),
      [`${scope}.model.name`]: this.mask(model),
      [`${scope}.model.parameters`]: serializeIO(modelParameters, this.secrets),
      [`${scope}.usage_details`]: serializeIO(usageDetails, this.secrets),
      [`${scope}.cost_details`]: serializeIO(costDetails, this.secrets),
      [`${scope}.completion_start_time`]: serializeIO(completionStartTime, this.secrets),
      [this.otlp ? "pi.version" : "langfuse.version"]: this.mask(version),
      "session.id": this.mask(sessionId),
      "user.id": this.mask(userId),
    });
    if (this.otlp && level === "ERROR") this.span.setStatus({ code: SpanStatusCode.ERROR });
    this.setMetadata(scope, metadata);
    return this;
  }

  updateTrace(attributes: ObservationAttributes): Observation {
    const { input, output, metadata, name, sessionId, userId, tags, version } = attributes;
    // Trace IO belongs to the receiving span without changing its observation IO.
    const scope = this.traceScope;
    this.span.setAttributes({
      [`${scope}.input`]: serializeIO(input, this.secrets),
      [`${scope}.output`]: serializeIO(output, this.secrets),
      [`${scope}.name`]: this.mask(name),
      [`${scope}.tags`]: tags?.map((tag) => maskSecretString(tag, this.secrets)),
      [this.otlp ? "pi.version" : "langfuse.version"]: this.mask(version),
      "session.id": this.mask(sessionId),
      "user.id": this.mask(userId),
    });
    this.setMetadata(scope, metadata);
    return this;
  }

  end(endTime?: number): Observation {
    // Write metadata last so it can only use slots left by trace and observation fields.
    for (const [key, value] of this.metadata) this.span.setAttribute(key, value);
    this.metadata.clear();
    this.span.end(endTime);
    return this;
  }

  private mask(value: string | undefined): string | undefined {
    return value === undefined ? undefined : maskSecretString(value, this.secrets);
  }

  private setMetadata(scope: string, metadata: Record<string, unknown> | undefined): void {
    if (!metadata || !this.span.isRecording()) return;
    for (const [key, value] of Object.entries(metadata)) {
      if (scope === this.observationScope && value == null) continue;
      const attribute = `${scope}.metadata.${maskSecretString(key, this.secrets)}`;
      if (this.metadata.size >= MAX_PENDING_METADATA_ATTRIBUTES && !this.metadata.has(attribute)) continue;
      const serialized =
        this.otlp && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
          ? value
          : this.otlp && typeof value === "string"
            ? this.mask(value)
            : serializeMetadataValue(value, this.secrets);
      if (serialized !== undefined) this.metadata.set(attribute, serialized);
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
    this.tracer = provider.getTracer(instrumentationScope(config));
    this.secrets = isOtlpConfig(config)
      ? otlpSecrets(config.headers)
      : [config.publicKey, config.secretKey].sort((a, b) => b.length - a.length);
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
    const config = this.config;
    const otlp = isOtlpConfig(config);
    const span = this.tracer.startSpan(
      maskSecretString(name, this.secrets),
      {
        startTime: options.startTime,
        ...(otlp && options.asType === "generation" ? { kind: SpanKind.CLIENT } : {}),
        attributes: otlp
          ? { "pi.observation.type": options.asType }
          : {
              "langfuse.observation.type": options.asType,
              "langfuse.internal.is_app_root": isAppRoot ? true : undefined,
              "langfuse.environment": config.environment && maskSecretString(config.environment, this.secrets),
              "langfuse.release": config.release && maskSecretString(config.release, this.secrets),
            },
      },
      parentContext,
    );
    this.spans.add(span);
    return new ProductionObservation(span, this.secrets, otlp).update(attributes);
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

export async function createOtelRuntime(config: OtlpRuntimeConfig): Promise<LangfuseRuntime> {
  return createSharedRuntime({ backend: "otlp", ...normalizeOtlpConnection({ ...config }) }, defaultFactories);
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
      throw new Error("Tracing was already shut down; restart the process to enable it again.");
    }
    if (shared.fingerprint !== fingerprint) {
      throw new Error("Tracing configuration changed; restart the process to apply the new connection settings.");
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
    provider = factories.createProvider(processor, config);
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
  constructor(config: ResolvedRuntimeConfig) {
    super({
      exporter: isOtlpConfig(config) ? createOtlpExporter(config) : createLangfuseExporter(config),
      // Keep batches smaller than the SDK default because each span can carry large captured inputs and outputs.
      maxExportBatchSize: 128,
      scheduledDelayMillis: 5_000,
    });
    this.scope = instrumentationScope(config);
  }

  private readonly scope: string;

  override onEnd(span: ReadableSpan): void {
    if (span.instrumentationScope.name === this.scope) super.onEnd(span);
  }
}

const defaultFactories: RuntimeFactories = {
  createProcessor: (config) => new PiBatchSpanProcessor(config),
  // The provider is private: do not register it with OpenTelemetry or replace the host's provider.
  createProvider: (processor, config) =>
    new TracerProvider({
      spanProcessors: [processor],
      ...(isOtlpConfig(config)
        ? {
            resource: resourceFromAttributes({
              "service.name": maskSecretString(config.serviceName, otlpSecrets(config.headers)),
            }),
          }
        : {}),
    }),
};

function createLangfuseExporter(config: ResolvedLangfuseConfig): OTLPTraceExporter {
  return new OTLPTraceExporter({
    url: `${config.baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
      "x-langfuse-ingestion-version": "4",
    },
    timeoutMillis: 5_000,
    compression: resolveCompression(),
  });
}

function createOtlpExporter(config: ResolvedOtlpConfig): OTLPExporterBase<ReadableSpan[]> {
  // The legacy exporter constructor merges ambient OTLP headers, which can send credentials to the wrong endpoint.
  return new OTLPExporterBase(
    createOtlpHttpExportDelegate(
      {
        ...getSharedConfigurationDefaults(),
        url: config.endpoint,
        headers: async () => ({ ...config.headers, "content-type": "application/x-protobuf" }),
        timeoutMillis: 5_000,
        agentFactory: httpAgentFactoryFromOptions({ keepAlive: true }),
      },
      ProtobufTraceSerializer,
      "otlp_http_span_exporter",
      TraceExporterMetricsHelper,
      undefined,
    ),
  );
}

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

export function resolveLangfuseRuntimeConfig(options: CreateLangfuseRuntimeOptions): ResolvedLangfuseConfig {
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
      isOtlpConfig(config)
        ? JSON.stringify([config.backend, config.endpoint, config.headers, config.serviceName])
        : `${config.publicKey}\0${config.secretKey}\0${config.baseUrl}\0${config.environment ?? ""}\0${config.release ?? ""}`,
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
