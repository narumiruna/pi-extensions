import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountStore } from "./account-store.js";
import type { AccountProviderAdapter } from "./oauth.js";
import { RuntimeAuthCoordinator } from "./runtime-auth.js";

const PREFIX = "anthropic-";
const PLACEHOLDER_KEY = "pi-accounts-pending";

type ModelConfig = { id: string; [key: string]: unknown };

export function registerAnthropicProviderAliases(
	pi: ExtensionAPI,
	store: AccountStore,
	adapter: AccountProviderAdapter,
): void {
	const coordinators = new Map<string, RuntimeAuthCoordinator>();
	let aliases = new Set<string>();
	let models: ModelConfig[] = [];

	const sync = async (ctx: ExtensionContext) => {
		const state = await store.readProviderAsync("anthropic");
		models = ctx.modelRegistry
			.getAvailable()
			.filter((model) => model.provider === "anthropic")
			.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => model as ModelConfig);
		const next = new Set(Object.keys(state.accounts).map((name) => `${PREFIX}${name}`));
		for (const alias of aliases) {
			if (next.has(alias)) continue;
			await coordinators.get(alias)?.clear(ctx);
			coordinators.delete(alias);
			pi.unregisterProvider(alias);
		}
		for (const alias of next) {
			registerAlias(pi, alias, models, PLACEHOLDER_KEY);
			const name = alias.slice(PREFIX.length);
			const coordinator = new RuntimeAuthCoordinator(pi, adapter, undefined, {
				providerId: alias,
				accountName: name,
			});
			coordinators.set(alias, coordinator);
			await coordinator.ensureActive(ctx, store);
		}
		aliases = next;
	};

	pi.on("session_start", async (_event, ctx) => {
		await sync(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		const alias = ctx.model?.provider;
		if (!alias?.startsWith(PREFIX)) return;
		const coordinator = coordinators.get(alias);
		if (!coordinator) throw new Error(`Anthropic account alias ${alias} is not configured.`);
		const result = await coordinator.ensureActive(ctx, store);
		if (result.status !== "active") {
			ctx.ui.notify(`Anthropic account ${alias.slice(PREFIX.length)} is unavailable.`, "error");
			ctx.abort();
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await Promise.allSettled(
			[...coordinators.values()].map((coordinator) => coordinator.clear(ctx)),
		);
	});
}

function registerAlias(pi: ExtensionAPI, id: string, models: ModelConfig[], apiKey: string): void {
	pi.unregisterProvider(id);
	pi.registerProvider(id, {
		name: id,
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages",
		apiKey,
		models: models as never,
	});
}
