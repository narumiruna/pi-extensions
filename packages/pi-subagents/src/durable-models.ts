import type { AnyModel, Models } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

function unsupported(operation: string): never {
  throw new Error(`Durable model bridge does not support ${operation} through the public ModelRegistry API`);
}

function rejectDeferred(options?: object): void {
  if (options && "deferred" in options && options.deferred) unsupported("deferred requests");
}

/**
 * Adapt the parent registry without a second credential store or provider runtime.
 * Auth stays inside registry request methods; caller options are never enriched or persisted here.
 *
 * Deferred requests cannot be polled or cancelled through ModelRegistry, so reject them before dispatch.
 * Credential inspection/management is intentionally unavailable. getProviders includes catalog providers
 * and extension registrations, but cannot discover built-in providers with an empty catalog.
 * Virtual streamSimple requests retain Pi's direct routing, not its stateful agent-loop routing.
 */
export function createDurableModels(registry: ModelRegistry): Models {
  const getAllModels = (provider?: string): readonly AnyModel[] => [
    ...registry.getModelsOfType("chat", provider),
    ...registry.getModelsOfType("image", provider),
    ...registry.getModelsOfType("classifier", provider),
  ];

  return {
    getProviders: () => {
      const ids = new Set([...getAllModels().map((model) => model.provider), ...registry.getRegisteredProviderIds()]);
      return [...ids].flatMap((id) => {
        const provider = registry.getProvider(id);
        return provider ? [provider] : [];
      });
    },
    getProvider: (id) => registry.getProvider(id),
    getModels: (provider) => registry.getModelsOfType("chat", provider),
    getModel: (provider, id) => registry.find(provider, id),
    getModelsOfType: (type, provider) => registry.getModelsOfType(type, provider),
    getModelOfType: (type, provider, id) => registry.getModelOfType(type, provider, id),
    getAllModels,
    refresh: (options) => registry.refresh(options),
    getAvailable: (provider, options) => registry.getAvailableOfType("chat", provider, options),
    getAvailableOfType: (type, provider, options) => registry.getAvailableOfType(type, provider, options),
    getAllAvailable: async (provider, options) =>
      (
        await Promise.all([
          registry.getAvailableOfType("chat", provider, options),
          registry.getAvailableOfType("image", provider, options),
          registry.getAvailableOfType("classifier", provider, options),
        ])
      ).flat(),
    stream: (model, context, options) => {
      rejectDeferred(options);
      return registry.stream(model, context, options);
    },
    complete: async (model, context, options) => {
      rejectDeferred(options);
      return registry.complete(model, context, options);
    },
    streamSimple: (model, context, options) => {
      rejectDeferred(options);
      return registry.streamSimple(model, context, options);
    },
    completeSimple: async (model, context, options) => {
      rejectDeferred(options);
      return registry.streamSimple(model, context, options).result();
    },
    generateImages: (model, context, options) => registry.generateImages(model, context, options),
    classify: (model, context, options) => registry.classify(model, context, options),
    streamDeferred: () => unsupported("streamDeferred"),
    fetchDeferred: async () => unsupported("fetchDeferred"),
    cancelDeferred: async () => unsupported("cancelDeferred"),
    checkAuth: async () => unsupported("checkAuth"),
    getAuth: async () => unsupported("getAuth"),
    login: async () => unsupported("login"),
    logout: async () => unsupported("logout"),
  };
}
