import { STATE_WAIT_HEARTBEAT_MS } from "./protocol.js";

export class ParticipantStateWait {
  private revision = 0n;
  private wake?: () => void;

  get version() {
    return this.revision.toString();
  }

  changed() {
    this.revision++;
    this.wake?.();
  }

  wait(version: unknown, signal: AbortSignal | undefined) {
    signal?.throwIfAborted();
    this.wake?.();
    if (version !== this.version) return;
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.wake = undefined;
        resolve();
      };
      const abort = () => {
        reject(signal?.reason);
        finish();
      };
      const timer = setTimeout(finish, STATE_WAIT_HEARTBEAT_MS);
      timer.unref();
      this.wake = finish;
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
