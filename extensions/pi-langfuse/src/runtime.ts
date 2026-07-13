import { createHash } from "node:crypto";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
	type LangfuseObservation,
	type LangfuseObservationAttributes,
	type LangfuseTraceAttributes,
	startObservation,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { LangfuseConfig } from "./config.js";
import type { Observation, ObservationAttributes, TraceBackend } from "./tracing.js";

const RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v1");

interface SharedRuntime {
	fingerprint: string;
	backend: ProductionTraceBackend;
	shutdown: boolean;
}

type GlobalWithRuntime = typeof globalThis & {
	[RUNTIME_KEY]?: Promise<SharedRuntime>;
};

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
		private readonly sdk: NodeSDK,
		private readonly processor: LangfuseSpanProcessor,
	) {}

	start(
		name: string,
		attributes: ObservationAttributes,
		options: { asType: "span" | "generation"; parent?: Observation },
	): Observation {
		const parent = options.parent;
		if (parent instanceof ProductionObservation) {
			const child =
				options.asType === "generation"
					? parent.native.startObservation(name, attributes as LangfuseObservationAttributes, {
							asType: "generation",
						})
					: parent.native.startObservation(name, attributes as LangfuseObservationAttributes);
			return new ProductionObservation(child);
		}

		const root =
			options.asType === "generation"
				? startObservation(name, attributes as LangfuseObservationAttributes, {
						asType: "generation",
					})
				: startObservation(name, attributes as LangfuseObservationAttributes);
		return new ProductionObservation(root);
	}

	async forceFlush(): Promise<void> {
		await this.processor.forceFlush();
	}

	async shutdown(): Promise<void> {
		await this.sdk.shutdown();
	}
}

export async function createProductionBackend(config: LangfuseConfig): Promise<TraceBackend> {
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

	const initializing = initializeRuntime(config, fingerprint);
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
): Promise<SharedRuntime> {
	const secrets = [config.secretKey, config.publicKey];
	const processor = new LangfuseSpanProcessor({
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
	const sdk = new NodeSDK({ spanProcessors: [processor] });
	await sdk.start();
	const backend = new ProductionTraceBackend(sdk, processor);
	const runtime: SharedRuntime = { fingerprint, backend, shutdown: false };
	const originalShutdown = backend.shutdown.bind(backend);
	backend.shutdown = async () => {
		if (runtime.shutdown) return;
		runtime.shutdown = true;
		await originalShutdown();
	};
	return runtime;
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
