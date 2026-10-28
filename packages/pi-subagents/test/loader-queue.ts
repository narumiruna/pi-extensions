interface ReloadableLoader {
  reload(): Promise<void>;
  getExtensions(): { runtime: { invalidate(reason: string): void } };
}

// Vitest aborts its timeout wrapper, not reload(). Keep ownership until reload settles.
export function createLoaderQueue() {
  let pending = Promise.resolve();
  return {
    run<Loader extends ReloadableLoader>(
      create: () => Loader,
      signal: AbortSignal,
      inspect: (loader: Loader) => unknown,
    ): Promise<void> {
      const work = pending.then(async () => {
        signal.throwIfAborted();
        const loader = create();
        const originalRuntime = loader.getExtensions().runtime;
        try {
          await loader.reload();
          signal.throwIfAborted();
          await inspect(loader);
        } finally {
          originalRuntime.invalidate("generated Jiti smoke complete");
          const currentRuntime = loader.getExtensions().runtime;
          if (currentRuntime !== originalRuntime) currentRuntime.invalidate("generated Jiti smoke complete");
        }
      });
      pending = work.catch(() => {});
      return work;
    },
    drain(): Promise<void> {
      return pending;
    },
  };
}
