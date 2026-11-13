import { type ChildProcess, fork } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { checkGeometry, checkPixels, LIMITS } from "./render-limits.mjs";

export { LIMITS } from "./render-limits.mjs";

export type Appearance = "dark" | "light";
export type DiagramLayout = {
  svg: string;
  width: number;
  height: number;
  kind: "svg" | "mermaid";
};
export interface RasterResult {
  /** Base64 PNG without a data URL prefix. */
  png: string;
  width: number;
  height: number;
}

type Request =
  | { operation: "layout"; kind: DiagramLayout["kind"]; source: string }
  | { operation: "raster"; layout: DiagramLayout; appearance: Appearance; widthPx: number };
interface Job {
  request: Request;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (value: DiagramLayout | RasterResult) => void;
  reject: (error: Error) => void;
  stop?: (error: Error) => void;
}

/** Cap a requested preview width without changing the layout or aspect ratio. */
export function rasterWidth(layout: Pick<DiagramLayout, "width" | "height">, requested: number): number {
  checkGeometry(layout.width, layout.height);
  if (!Number.isFinite(requested) || requested < 1) throw new Error("Invalid raster width.");
  const ratio = layout.width / layout.height;
  let width = Math.floor(
    Math.min(
      requested,
      LIMITS.maxRasterDimension,
      LIMITS.maxRasterDimension * ratio,
      Math.sqrt(LIMITS.maxPixels * ratio),
    ),
  );
  // Match the worker's arithmetic and integer height, not only the continuous area cap.
  const heightFor = (width: number) => Math.max(1, Math.round((width * layout.height) / layout.width));
  while (width > 1 && width * heightFor(width) > LIMITS.maxPixels) width--;
  checkPixels(width, heightFor(width));
  return width;
}

export class RenderQueueFullError extends Error {
  constructor() {
    super("Diagram render queue is full.");
    this.name = "RenderQueueFullError";
  }
}

function aborted(): Error {
  return new DOMException("Diagram rendering cancelled.", "AbortError");
}

/** Source-derived diagnostics are terminal-safe and bounded; raw input is never changed. */
export function renderError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    stripVTControlCharacters(message)
      .replace(/\p{Cc}/gu, " ")
      .slice(0, 400),
  );
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_DATA_HOME",
    "XDG_DATA_DIRS",
    "FONTCONFIG_PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

/** One killable child worker at a time, with at most four accepted operations, including queued work. */
export class Rasterizer {
  private readonly queue: Job[] = [];
  private current: Job | undefined;
  private closed = false;
  private disposal: Promise<void> | undefined;
  private idle: (() => void) | undefined;

  /** Accepted work, including the currently running operation and the bounded queue. */
  get active(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  async layout(kind: DiagramLayout["kind"], source: string, signal?: AbortSignal): Promise<DiagramLayout> {
    if (kind !== "svg" && kind !== "mermaid") throw new Error("Unsupported diagram kind.");
    if (typeof source !== "string" || !source.trim() || source.length > LIMITS.sourceChars) {
      throw new Error(`Diagram source must contain 1 to ${LIMITS.sourceChars} characters.`);
    }
    return (await this.submit({ operation: "layout", kind, source }, signal)) as DiagramLayout;
  }

  async raster(
    layout: DiagramLayout,
    appearance: Appearance,
    widthPx: number,
    signal?: AbortSignal,
  ): Promise<RasterResult> {
    if (appearance !== "dark" && appearance !== "light") throw new Error("Unsupported appearance.");
    if (layout.kind !== "svg" && layout.kind !== "mermaid") throw new Error("Unsupported diagram kind.");
    if (typeof layout.svg !== "string" || Buffer.byteLength(layout.svg) > LIMITS.svgBytes) {
      throw new Error("SVG exceeds the 4 MiB limit.");
    }
    checkGeometry(layout.width, layout.height);
    checkPixels(widthPx, Math.max(1, Math.round((widthPx * layout.height) / layout.width)));
    // Snapshot caller-owned mutable data before queueing or awaiting.
    return (await this.submit(
      { operation: "raster", layout: { ...layout }, appearance, widthPx },
      signal,
    )) as RasterResult;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = new Promise<void>((resolve) => {
      this.idle = resolve;
    });
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(new Error("Rasterizer is disposed."));
    }
    if (this.current) this.current.stop?.(new Error("Rasterizer is disposed."));
    else this.idle?.();
    return this.disposal;
  }

  private submit(request: Request, signal?: AbortSignal): Promise<DiagramLayout | RasterResult> {
    if (this.closed) return Promise.reject(new Error("Rasterizer is disposed."));
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.active >= LIMITS.maxPending) return Promise.reject(new RenderQueueFullError());
    return new Promise((resolve, reject) => {
      const job: Job = {
        request,
        signal,
        resolve,
        reject,
        abort: () => {
          if (this.current === job) job.stop?.(aborted());
          else {
            const index = this.queue.indexOf(job);
            if (index !== -1) this.queue.splice(index, 1);
            signal?.removeEventListener("abort", job.abort);
            reject(aborted());
          }
        },
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed || this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    let worker: ChildProcess;
    try {
      // A child process, not a V8 thread: SIGKILL also stops synchronous native resvg work.
      // Native ESM stays beside this module in the source package and in tsc's test output.
      worker = fork(new URL("./render-worker.mjs", import.meta.url), [], {
        execPath: process.execPath,
        execArgv: [`--max-old-space-size=${LIMITS.heapMb}`, "--stack_size=4096"],
        env: workerEnvironment(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
      });
    } catch (error) {
      this.current = undefined;
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(renderError(error));
      this.pump();
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    let finished = false;
    let settled = false;
    let stopped = false;
    let ready = false;
    let failure: Error | undefined;
    let result: DiagramLayout | RasterResult | undefined;
    let timer = setTimeout(() => finish(new Error("Diagram worker startup timed out.")), LIMITS.startupMs);
    const finish = (error?: Error, value?: DiagramLayout | RasterResult): void => {
      if (finished) return;
      finished = true;
      failure = error;
      result = value;
      clearTimeout(timer);
      job.signal?.removeEventListener("abort", job.abort);
      if (stopped) settle();
      else {
        try {
          worker.kill("SIGKILL");
        } catch (killError) {
          failure ??= renderError(killError);
        }
        // A false kill result can race with exit. Only exit/close (or failed spawn) releases the slot.
      }
    };
    const settle = (): void => {
      if (settled) return;
      settled = true;
      worker.stdout?.destroy();
      worker.stderr?.destroy();
      this.current = undefined;
      if (failure) job.reject(failure.name === "AbortError" ? aborted() : renderError(failure));
      else if (job.signal?.aborted) job.reject(aborted());
      else if (this.closed) job.reject(new Error("Rasterizer is disposed."));
      else if (result) job.resolve(result);
      else job.reject(new Error("Diagram worker returned no result."));
      if (this.closed) this.idle?.();
      else this.pump();
    };
    job.stop = (error) => finish(error);
    worker.on("message", (message: { type: string; value?: DiagramLayout | RasterResult; error?: string }) => {
      if (finished) return;
      if (message.type === "ready" && !ready) {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("Diagram rendering timed out.")), LIMITS.timeoutMs);
        try {
          worker.send(job.request, (error) => {
            if (error) finish(renderError(error));
          });
        } catch (error) {
          finish(renderError(error));
        }
      } else if (ready && message.type === "result") {
        const value = message.value;
        if (value && "png" in value && value.png.length > 4 * Math.ceil(LIMITS.pngBytes / 3))
          finish(new Error("PNG exceeds the 4 MiB limit."));
        else if (value && "svg" in value && Buffer.byteLength(value.svg) > LIMITS.svgBytes)
          finish(new Error("SVG exceeds the 4 MiB limit."));
        else finish(undefined, value);
      } else if (ready && message.type === "error") finish(new Error(message.error ?? "Diagram rendering failed."));
      else finish(new Error("Invalid diagram worker response."));
    });
    worker.once("error", (error) => {
      if (!worker.pid) stopped = true; // Failed spawn can emit error without exit.
      if (!finished) finish(renderError(error));
      else if (stopped) settle();
    });
    const onStopped = () => {
      stopped = true;
      if (!finished) finish(new Error("Diagram worker exited without a result."));
      else settle();
    };
    worker.once("exit", onStopped);
    worker.once("close", onStopped);
  }
}
