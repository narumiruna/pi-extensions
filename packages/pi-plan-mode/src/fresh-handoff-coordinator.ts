export interface DeferredFreshHandoffDependencies {
	schedule(callback: () => void): unknown;
	cancel(handle: unknown): void;
}

export interface DeferredFreshHandoffCoordinator {
	schedule(
		run: (isCurrent: () => boolean) => Promise<void>,
		onError: (error: unknown) => void,
	): void;
	cancel(): void;
}

const defaultDependencies: DeferredFreshHandoffDependencies = {
	schedule: (callback) => setTimeout(callback, 0),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createDeferredFreshHandoffCoordinator(
	dependencies: DeferredFreshHandoffDependencies = defaultDependencies,
): DeferredFreshHandoffCoordinator {
	let generation = 0;
	let pending: { generation: number; handle: unknown } | undefined;

	const cancel = () => {
		generation += 1;
		if (!pending) return;
		dependencies.cancel(pending.handle);
		pending = undefined;
	};

	return {
		schedule(run, onError) {
			cancel();
			const taskGeneration = generation;
			const handle = dependencies.schedule(() => {
				if (pending?.generation !== taskGeneration || generation !== taskGeneration) return;
				pending = undefined;
				const isCurrent = () => generation === taskGeneration;
				void Promise.resolve()
					.then(() => run(isCurrent))
					.catch((error: unknown) => {
						if (!isCurrent()) return;
						try {
							onError(error);
						} catch {
							// Detached error reporting must not create another unhandled rejection.
						}
					});
			});
			pending = { generation: taskGeneration, handle };
		},
		cancel,
	};
}
