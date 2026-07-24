export interface AsyncRefreshControllerOptions<Input, Snapshot> {
	read(input: Input): Promise<Snapshot>;
	equal(left: Snapshot | undefined, right: Snapshot): boolean;
	publish(snapshot: Snapshot): void;
	onError?(error: unknown): void;
}

interface RefreshRequest<Input> {
	generation: number;
	requestId: number;
	input: Input;
}

/** Coalesces refreshes to one active read plus the latest pending request. */
export class AsyncRefreshController<Input, Snapshot> {
	private generation: number | undefined;
	private requestId = 0;
	private inFlight = false;
	private pending: RefreshRequest<Input> | undefined;
	private current: Snapshot | undefined;

	constructor(private readonly options: AsyncRefreshControllerOptions<Input, Snapshot>) {}

	start(generation: number): void {
		this.generation = generation;
		this.requestId += 1;
		this.pending = undefined;
		this.current = undefined;
	}

	clear(): void {
		this.current = undefined;
	}

	request(input: Input): void {
		if (this.generation === undefined) return;
		const request = {
			generation: this.generation,
			requestId: ++this.requestId,
			input,
		};
		if (this.inFlight) {
			this.pending = request;
			return;
		}
		this.run(request);
	}

	stop(): void {
		this.generation = undefined;
		this.requestId += 1;
		this.pending = undefined;
		this.current = undefined;
	}

	private run(request: RefreshRequest<Input>): void {
		if (!this.isCurrentTarget(request)) return;
		this.inFlight = true;
		void this.options
			.read(request.input)
			.then((snapshot) => {
				if (!this.isCurrentRequest(request)) return;
				if (this.options.equal(this.current, snapshot)) return;
				this.current = snapshot;
				this.options.publish(snapshot);
			})
			.catch((error: unknown) => {
				if (this.isCurrentRequest(request)) this.options.onError?.(error);
			})
			.finally(() => {
				this.inFlight = false;
				const pending = this.pending;
				this.pending = undefined;
				if (pending) this.run(pending);
			});
	}

	private isCurrentTarget(request: RefreshRequest<Input>): boolean {
		return this.generation !== undefined && request.generation === this.generation;
	}

	private isCurrentRequest(request: RefreshRequest<Input>): boolean {
		return this.isCurrentTarget(request) && request.requestId === this.requestId;
	}
}
