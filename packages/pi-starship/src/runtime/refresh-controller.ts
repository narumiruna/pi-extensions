export interface AsyncRefreshControllerOptions<Input, Snapshot> {
  read(input: Input, signal: AbortSignal): Promise<Snapshot>;
  equal(left: Snapshot | undefined, right: Snapshot): boolean;
  publish(snapshot: Snapshot): void;
  onError?(error: unknown): void;
}

interface RefreshRequest<Input> {
  generation: number;
  requestId: number;
  input: Input;
}

interface ActiveRefresh<Input> {
  request: RefreshRequest<Input>;
  controller: AbortController;
}

/** Coalesces refreshes to one active read plus the latest pending request. */
export class AsyncRefreshController<Input, Snapshot> {
  private generation: number | undefined;
  private requestId = 0;
  private active: ActiveRefresh<Input> | undefined;
  private pending: RefreshRequest<Input> | undefined;
  private current: Snapshot | undefined;

  constructor(private readonly options: AsyncRefreshControllerOptions<Input, Snapshot>) {}

  start(generation: number): void {
    this.cancelActive("Refresh generation replaced");
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
    if (this.active) {
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
    this.cancelActive("Refresh controller stopped");
  }

  private run(request: RefreshRequest<Input>): void {
    if (!this.isCurrentTarget(request)) return;
    const active: ActiveRefresh<Input> = {
      request,
      controller: new AbortController(),
    };
    this.active = active;
    void this.options
      .read(request.input, active.controller.signal)
      .then((snapshot) => {
        if (this.active !== active || !this.isCurrentRequest(request)) return;
        if (this.options.equal(this.current, snapshot)) return;
        this.current = snapshot;
        this.options.publish(snapshot);
      })
      .catch((error: unknown) => {
        if (this.active === active && this.isCurrentRequest(request) && !active.controller.signal.aborted) {
          this.options.onError?.(error);
        }
      })
      .finally(() => {
        if (this.active !== active) return;
        this.active = undefined;
        const pending = this.pending;
        this.pending = undefined;
        if (pending) this.run(pending);
      });
  }

  private cancelActive(reason: string): void {
    this.active?.controller.abort(new DOMException(reason, "AbortError"));
  }

  private isCurrentTarget(request: RefreshRequest<Input>): boolean {
    return this.generation !== undefined && request.generation === this.generation;
  }

  private isCurrentRequest(request: RefreshRequest<Input>): boolean {
    return this.isCurrentTarget(request) && request.requestId === this.requestId;
  }
}
