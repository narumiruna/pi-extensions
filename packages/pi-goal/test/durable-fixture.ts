import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createRegistry,
  type Extension,
  Harness,
  type HarnessSettings,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";

export const context = BACKGROUND_CONTEXT;

/** A finite synthetic provider, never a live provider or a Goal implementation. */
export async function openDurableFixture(
  extensions: Extension[] = [],
  responses: FauxResponseStep[] = [fauxAssistantMessage("finished")],
  settings: HarnessSettings = {},
  storage: Storage = new MemoryStorage(),
) {
  const faux = fauxProvider({ deferred: { pollAfterMs: 0, pendingFetches: 2 } });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const reports: unknown[] = [];
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        compaction: { enabled: false, backgroundTokens: 0, keepRecentTokens: 16 },
        retry: { enabled: false },
        ...settings,
      },
      onReport: (error) => reports.push(error),
    },
    context,
  );
  try {
    const model = faux.getModel();
    const root = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    return { harness, root, faux, registry, reports };
  } catch (error) {
    await harness.close(context);
    throw error;
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
