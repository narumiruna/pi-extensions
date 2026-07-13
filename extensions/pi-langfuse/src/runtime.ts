import { createHash } from "node:crypto";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
	type LangfuseObservation,
	type LangfuseObservationAttributes,
	type LangfuseTraceAttributes,
	setLangfuseTracerProvider,
	startObservation,
} from "@langfuse/tracing";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LangfuseConfig } from "./config.js";
import type {
	Observation,
	ObservationAttributes,
	ObservationType,
	TraceBackend,
} from "./tracing.js";

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
		this.native.updateOtelSpanAttributes(attributes as LangfuseObservationAttributes);
		return this;
	}

	updateTrace(attributes: ObservationAttributes): Observation {
		this.native.updateTrace(attributes as LangfuseTraceAttributes);
		return this;
	}

	end(): Observation {
		this.native.end();
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
		const parent = options.parent;
		if (parent instanceof ProductionObservation) {
			return new ProductionObservation(
				startChild(parent.native, name, attributes, options.asType),
			);
		}
		return new ProductionObservation(startRoot(name, attributes, options.asType));
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
			shouldExportSpan: ({ otelSpan }) =>
				typeof otelSpan.attributes["langfuse.observation.type"] === "string",
		});
	},
	createProvider: (processor) => new NodeTracerProvider({ spanProcessors: [processor] }),
	selectProvider: setLangfuseTracerProvider,
};

function startRoot(
	name: string,
	attributes: ObservationAttributes,
	type: ObservationType,
): LangfuseObservation {
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
	if (typeof data === "string") {
		let masked = data.replace(/\b(?:sk|pk)-lf-[A-Za-z0-9_-]+\b/g, "[LANGFUSE_KEY_REDACTED]");
		for (const secret of secrets) {
			if (secret) masked = masked.replaceAll(secret, "[LANGFUSE_KEY_REDACTED]");
		}
		return masked;
	}
	if (Array.isArray(data)) return data.map((item) => maskSecrets(item, secrets));
	if (data && typeof data === "object") {
		return Object.fromEntries(
			Object.entries(data).map(([key, value]) => [key, maskSecrets(value, secrets)]),
		);
	}
	return data;
}
