import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { EngineModelRegistry, EngineModelStream } from "./engine/host.js";
import { modelSignature } from "./model-signature.js";
import type { ClientFacts } from "./protocol.js";

export interface ResolverHost {
  model?: Model<Api>;
  registry: EngineModelRegistry;
  unavailable?: string;
  settle(): Promise<void>;
}
const DIFFERENT =
  "The selected model is unavailable: its definition or auth source differs in the standalone daemon. No fallback model was selected.";
/** No resource discovery or extension loading; credential work starts only for a resolver request. */
export async function prepareResolverHost(
  root: string,
  binding: ClientFacts["model"],
  signal?: AbortSignal,
): Promise<ResolverHost> {
  const unavailable = (reason: string): ResolverHost => ({
    unavailable: reason,
    registry: {
      streamSimple: () => {
        throw new Error(reason);
      },
    },
    settle: async () => {},
  });
  signal?.throwIfAborted();
  if (!binding)
    return unavailable(
      "No independently available daemon resolver model is authorized; parent-only runtime providers are unavailable.",
    );
  const [{ ModelRuntime, ModelRegistry }, { InMemoryCredentialStore }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]);
  signal?.throwIfAborted();
  // Read public static definitions without touching auth.json, refreshing OAuth,
  // evaluating credential commands, or discovering catalogs over the network.
  const metadata = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: path.join(root, "models.json"),
    refreshOnCreate: false,
  });
  signal?.throwIfAborted();
  const model = metadata.getModel(binding.provider, binding.id);
  if (metadata.getError() || !model || modelSignature(model) !== binding.signature) return unavailable(DIFFERENT);
  let runtime: ModelRuntime | undefined;
  let loading: Promise<{ registry: EngineModelRegistry; model: Model<Api> }> | undefined;
  const load = (requestSignal?: AbortSignal) =>
    (loading ??= (async () => {
      requestSignal?.throwIfAborted();
      runtime = await ModelRuntime.create({
        authPath: path.join(root, "auth.json"),
        modelsPath: path.join(root, "models.json"),
        refreshOnCreate: false,
      });
      requestSignal?.throwIfAborted();
      if (runtime.getError() || modelSignature(runtime.getModel(binding.provider, binding.id)) !== binding.signature)
        throw new Error(DIFFERENT);
      await runtime.refresh({ allowNetwork: false, providers: [binding.provider], signal: requestSignal });
      requestSignal?.throwIfAborted();
      const actual = runtime.getModel(binding.provider, binding.id);
      if (
        runtime.getError() ||
        !actual ||
        modelSignature(actual) !== binding.signature ||
        runtime.getProviderAuthStatus(binding.provider).source !== binding.authSource
      )
        throw new Error(DIFFERENT);
      return { registry: new ModelRegistry(runtime), model: actual };
    })());
  return {
    model,
    registry: {
      streamSimple(_model, context, options) {
        let upstream: Promise<EngineModelStream> | undefined;
        const get = () =>
          (upstream ??= load(options?.signal ?? signal).then((host) =>
            host.registry.streamSimple(host.model, context, options),
          ));
        return {
          async *[Symbol.asyncIterator]() {
            for await (const event of await get()) yield event;
          },
          async result() {
            return (await get()).result();
          },
        };
      },
    },
    async settle() {
      await loading?.catch(() => {});
      await runtime?.settleCredentialWrites();
    },
  };
}
