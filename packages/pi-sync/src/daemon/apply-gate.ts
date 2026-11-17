import { randomUUID } from "node:crypto";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withTargetQueues } from "@narumitw/pi-sync-daemon/engine/snapshot/snapshot-mutation-queues";

interface Gate {
  token: string;
  paths: readonly string[];
  entered: Promise<string>;
  task: Promise<void>;
  granted: boolean;
  cancelled: boolean;
  reject(error: unknown): void;
  release(): void;
}
/**
 * Holds the running Pi's actual public file queues; it does not authorize filesystem writes.
 * The engine owns reviewed destinations, which can differ from every participant's current roots.
 */
export class PiApplyGate {
  private gates = new Map<string, Gate>();
  constructor(private validate: () => void) {}
  async acquire(requestId: string, targets: readonly string[], signal?: AbortSignal) {
    this.validate();
    signal?.throwIfAborted();
    if (
      !targets.length ||
      targets.length > 16_384 ||
      targets.some((target) => typeof target !== "string" || target.includes("\0") || !path.isAbsolute(target))
    )
      throw new Error("Invalid daemon mutation targets.");
    const normalized = [...new Set(targets.map((target) => path.resolve(target)))].sort();
    const existing = this.gates.get(requestId);
    if (existing) {
      if (JSON.stringify(existing.paths) !== JSON.stringify(normalized)) throw new Error("File-queue request changed.");
      return existing.entered;
    }
    const token = randomUUID();
    let entered!: (token: string) => void;
    let rejected!: (error: unknown) => void;
    const ready = new Promise<string>((resolve, reject) => {
      entered = resolve;
      rejected = reject;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate: Gate = {
      token,
      paths: normalized,
      entered: ready,
      task: Promise.resolve(),
      release,
      reject: rejected,
      granted: false,
      cancelled: false,
    };
    this.gates.set(requestId, gate);
    const validate = () => {
      if (gate.cancelled) throw new DOMException("File-queue reservation was cancelled", "AbortError");
      this.validate();
    };
    gate.task = withTargetQueues(
      normalized,
      { signal, validateMutation: validate },
      async () => {
        validate();
        signal?.throwIfAborted();
        gate.granted = true;
        entered(token);
        // Prompt cancellation cannot revoke a grant while a remote writer may still run.
        await held;
      },
      { mutate: withFileMutationQueue },
    )
      .catch((error) => {
        rejected(error);
      })
      .finally(() => {
        if (this.gates.get(requestId) === gate) this.gates.delete(requestId);
      });
    const abort = () => {
      if (!gate.granted) {
        gate.cancelled = true;
        rejected(signal?.reason);
        release();
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    void gate.task.finally(() => signal?.removeEventListener("abort", abort));
    return ready;
  }
  async release(token: string) {
    const gate = [...this.gates.values()].find((value) => value.token === token);
    if (!gate) throw new Error("Unknown file-queue grant.");
    await this.releaseGate(gate);
  }
  private async releaseGate(gate: Gate) {
    if (!gate.granted) {
      gate.cancelled = true;
      gate.reject(new DOMException("File-queue reservation was released", "AbortError"));
    }
    gate.release();
    // A queued, ungranted placeholder cannot write after cancellation and need not
    // wait for another Pi tool to finish before acknowledgement.
    if (gate.granted) await gate.task;
  }
  async releaseRequest(requestId: string) {
    const gate = this.gates.get(requestId);
    if (!gate) return;
    await this.releaseGate(gate);
  }
  detach() {
    const failure = new DOMException("Pi session detached", "AbortError");
    this.validate = () => {
      throw failure;
    };
    this.cancelPending(failure);
  }
  cancelPending(failure: unknown = new DOMException("Pi session changing", "AbortError")) {
    for (const gate of this.gates.values())
      if (!gate.granted) {
        gate.cancelled = true;
        gate.reject(failure);
        gate.release();
      }
  }
  get size() {
    return [...this.gates.values()].filter((gate) => gate.granted || !gate.cancelled).length;
  }
  /** Release only after establishing that the associated service cannot still write. */
  async releaseAfterOwnerExit(pid: number) {
    try {
      process.kill(pid, 0);
      throw new Error("Daemon owner is still alive; grants remain held.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await this.releaseAfterDrain();
  }
  /** Caller must first receive an authenticated same-owner detach/drain acknowledgement. */
  async releaseAfterDrain() {
    await Promise.all([...this.gates.values()].map((gate) => this.releaseGate(gate)));
  }
}
