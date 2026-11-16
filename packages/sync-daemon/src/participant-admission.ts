/** Keep client publication outside complete mutation-queue reservation lifetimes. */
export class ParticipantAdmission {
  private tail = Promise.resolve();

  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.tail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => held);
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        void previous.then(resolve);
        abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      return await action();
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      release();
    }
  }
}
