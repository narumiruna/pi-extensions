import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type RuntimeAuthStorage = {
	setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void>;
	removeRuntimeApiKey(provider: string): void | Promise<void>;
};

type RuntimeOverrideState = {
	appliedApiKey?: string;
	generation: number;
	mayHaveOverride: boolean;
	operationTail: Promise<void>;
};

export type RuntimeOverrideSnapshot = {
	target: RuntimeAuthStorage & object;
	state: RuntimeOverrideState;
	generation: number;
};

export type RuntimeApiKeyApplyResult = "applied" | "stale" | "unavailable";

type RuntimeProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

export class RuntimeApiKeyBridge {
	private readonly pi: ExtensionAPI;
	private readonly providerId: string;
	private readonly fallbackApiKey: string;
	private registered = false;
	private previousProviderApiKey: { present: boolean; value?: string } | undefined;

	constructor(pi: ExtensionAPI, providerId: string, fallbackApiKey: string) {
		this.pi = pi;
		this.providerId = providerId;
		this.fallbackApiKey = fallbackApiKey;
	}

	prepare(ctx: ExtensionContext): void {
		if (this.registered) return;
		const current = this.getRegisteredProviderConfig(ctx);
		this.previousProviderApiKey = current
			? { present: Object.hasOwn(current, "apiKey"), value: current.apiKey }
			: { present: false };
		this.pi.registerProvider(this.providerId, { ...current, apiKey: this.fallbackApiKey });
		this.registered = true;
	}

	remove(ctx: ExtensionContext): void {
		if (!this.registered) return;
		const current = this.getRegisteredProviderConfig(ctx);
		if (current && current.apiKey !== this.fallbackApiKey) {
			this.reset();
			return;
		}
		this.pi.unregisterProvider(this.providerId);
		if (current) {
			const { apiKey: _bridgeApiKey, ...withoutBridge } = current;
			const restored = withoutBridge as RuntimeProviderConfig;
			if (this.previousProviderApiKey?.present) {
				restored.apiKey = this.previousProviderApiKey.value;
			}
			if (Object.keys(restored).length > 0) {
				this.pi.registerProvider(this.providerId, restored);
			}
		}
		this.reset();
	}

	private getRegisteredProviderConfig(ctx: ExtensionContext): RuntimeProviderConfig | undefined {
		const registry = ctx.modelRegistry as unknown as {
			getRegisteredProviderConfig?: (provider: string) => RuntimeProviderConfig | undefined;
			registeredProviders?: Map<string, RuntimeProviderConfig>;
		};
		if (typeof registry.getRegisteredProviderConfig === "function") {
			return registry.getRegisteredProviderConfig(this.providerId);
		}
		// Pi 0.79/0.80.3 have the same provider merge semantics but expose only this map.
		return registry.registeredProviders instanceof Map
			? registry.registeredProviders.get(this.providerId)
			: undefined;
	}

	private reset(): void {
		this.registered = false;
		this.previousProviderApiKey = undefined;
	}
}

export class RuntimeApiKeyController {
	private readonly providerId: string;
	private readonly states = new WeakMap<object, RuntimeOverrideState>();

	constructor(providerId: string) {
		this.providerId = providerId;
	}

	capture(ctx: ExtensionContext): RuntimeOverrideSnapshot | undefined {
		const target = getRuntimeAuthStorage(ctx);
		if (!target) return undefined;
		const state = this.getState(target);
		return { target, state, generation: state.generation };
	}

	async apply(
		ctx: ExtensionContext,
		snapshot: RuntimeOverrideSnapshot | undefined,
		apiKey: string,
	): Promise<RuntimeApiKeyApplyResult> {
		if (!(await this.set(snapshot, apiKey))) return "stale";
		const matches = await this.matches(ctx, apiKey);
		if (matches !== false) return "applied";
		if (!(await this.set(snapshot, apiKey, true))) return "stale";
		return (await this.matches(ctx, apiKey)) === false ? "unavailable" : "applied";
	}

	async clear(ctx: ExtensionContext): Promise<void> {
		const target = getRuntimeAuthStorage(ctx);
		if (!target) return;
		const state = this.states.get(target);
		if (!state) return;
		state.generation += 1;
		await enqueueMutation(state, async () => {
			if (!state.mayHaveOverride) return;
			await target.removeRuntimeApiKey(this.providerId);
			state.appliedApiKey = undefined;
			state.mayHaveOverride = false;
		});
	}

	private async matches(
		ctx: ExtensionContext,
		expectedApiKey: string,
	): Promise<boolean | undefined> {
		const registry = ctx.modelRegistry as unknown as {
			getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
		};
		if (typeof registry.getApiKeyForProvider !== "function") return undefined;
		try {
			return (await registry.getApiKeyForProvider(this.providerId)) === expectedApiKey;
		} catch {
			return false;
		}
	}

	private async set(
		snapshot: RuntimeOverrideSnapshot | undefined,
		apiKey: string,
		force = false,
	): Promise<boolean> {
		if (!snapshot) {
			throw new Error("This Pi version does not expose runtime provider authentication.");
		}
		const { generation, state, target } = snapshot;
		return enqueueMutation(state, async () => {
			if (state.generation !== generation) return false;
			if (!force && state.appliedApiKey === apiKey) return true;
			state.appliedApiKey = undefined;
			state.mayHaveOverride = true;
			await target.setRuntimeApiKey(this.providerId, apiKey);
			state.appliedApiKey = apiKey;
			return state.generation === generation;
		});
	}

	private getState(target: object): RuntimeOverrideState {
		let state = this.states.get(target);
		if (!state) {
			state = {
				generation: 0,
				mayHaveOverride: false,
				operationTail: Promise.resolve(),
			};
			this.states.set(target, state);
		}
		return state;
	}
}

function enqueueMutation<T>(state: RuntimeOverrideState, mutate: () => Promise<T>): Promise<T> {
	const operation = state.operationTail.then(mutate);
	state.operationTail = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

function getRuntimeAuthStorage(ctx: ExtensionContext): (RuntimeAuthStorage & object) | undefined {
	const registry = ctx.modelRegistry as unknown as {
		authStorage?: unknown;
		runtime?: unknown;
	};
	for (const candidate of [registry, registry.runtime, registry.authStorage]) {
		if (isRuntimeAuthStorage(candidate)) return candidate;
	}
	return undefined;
}

function isRuntimeAuthStorage(value: unknown): value is RuntimeAuthStorage & object {
	return (
		!!value &&
		typeof value === "object" &&
		"setRuntimeApiKey" in value &&
		typeof value.setRuntimeApiKey === "function" &&
		"removeRuntimeApiKey" in value &&
		typeof value.removeRuntimeApiKey === "function"
	);
}
