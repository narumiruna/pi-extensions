import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

class ControlledChild extends EventEmitter {
  static children: ControlledChild[] = [];
  static fail = false;
  pid: number | undefined = 12345;
  readonly stdout = { resume: vi.fn(), destroy: vi.fn() };
  readonly stderr = { resume: vi.fn(), destroy: vi.fn() };
  readonly send = vi.fn((_request: unknown, callback: (error: Error | null) => void) => {
    callback(null);
    return true;
  });
  readonly kill = vi.fn(() => true);
  constructor(
    readonly url: URL,
    readonly options: unknown,
  ) {
    super();
    if (ControlledChild.fail) throw new Error("startup failed");
    ControlledChild.children.push(this);
  }
  release() {
    this.emit("exit", null, "SIGKILL");
    this.emit("close", null, "SIGKILL");
  }
  ready() {
    this.emit("message", { type: "ready" });
  }
  result() {
    this.emit("message", { type: "result", value: { svg: source, width: 1, height: 1, kind: "svg" } });
  }
}

let Rasterizer: typeof import("../src/rasterizer.js").Rasterizer;
let LIMITS: typeof import("../src/rasterizer.js").LIMITS;
let RenderQueueFullError: typeof import("../src/rasterizer.js").RenderQueueFullError;
const services: import("../src/rasterizer.js").Rasterizer[] = [];
const source = '<svg width="1" height="1"/>';
const current = () => ControlledChild.children.at(-1) as ControlledChild;
function service() {
  const renderer = new Rasterizer();
  services.push(renderer);
  return renderer;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  ControlledChild.children = [];
  ControlledChild.fail = false;
  vi.doMock("node:child_process", () => ({
    fork: (url: URL, _args: unknown, options: unknown) => new ControlledChild(url, options),
  }));
  ({ Rasterizer, LIMITS, RenderQueueFullError } = await import("../src/rasterizer.js"));
});
afterEach(async () => {
  const disposal = services.splice(0).map((renderer) => renderer.dispose());
  for (const child of ControlledChild.children) child.release();
  await Promise.all(disposal);
  vi.doUnmock("node:child_process");
  vi.useRealTimers();
});

it("does no process or timer work on construction, pre-abort, or repeated disposal", async () => {
  const renderer = service();
  expect(ControlledChild.children).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  const abort = new AbortController();
  abort.abort();
  await expect(renderer.layout("svg", source, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(ControlledChild.children).toHaveLength(0);
  const disposed = renderer.dispose();
  expect(renderer.dispose()).toBe(disposed);
  await disposed;
  await expect(renderer.layout("svg", source)).rejects.toThrow(/disposed/);
});

it("uses an isolated native child with a font/platform-only environment", async () => {
  vi.stubEnv("NODE_OPTIONS", "--expose-gc");
  vi.stubEnv("OPENAI_API_KEY", "private");
  try {
    const renderer = service();
    const task = renderer.layout("svg", source);
    const child = current();
    expect(child.url.pathname).toMatch(/render-worker\.mjs$/);
    expect(child.options).toMatchObject({
      execPath: process.execPath,
      execArgv: [`--max-old-space-size=${LIMITS.heapMb}`, "--stack_size=4096"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    const env = (child.options as { env: NodeJS.ProcessEnv }).env;
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HOME).toBe(process.env.HOME);
    child.ready();
    child.result();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.release();
    await task;
  } finally {
    vi.unstubAllEnvs();
  }
});

it("starts the work deadline only after the ready handshake", async () => {
  const renderer = service();
  const task = renderer.layout("svg", source);
  const child = current();
  expect(child.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(LIMITS.startupMs - 1);
  expect(child.kill).not.toHaveBeenCalled();
  child.ready();
  expect(child.send).toHaveBeenCalledWith({ operation: "layout", kind: "svg", source }, expect.any(Function));
  await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs - 1);
  expect(child.kill).not.toHaveBeenCalled();
  child.result();
  child.release();
  await expect(task).resolves.toMatchObject({ width: 1 });
  expect(renderer.active).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["readiness", "work"])("SIGKILLs on %s timeout and waits for actual exit", async (phase) => {
  const renderer = service();
  const task = renderer.layout("svg", source);
  const rejected = expect(task).rejects.toThrow(/timed out/);
  const child = current();
  if (phase === "work") child.ready();
  await vi.advanceTimersByTimeAsync(phase === "work" ? LIMITS.timeoutMs : LIMITS.startupMs);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(renderer.active).toBe(1);
  child.release();
  await rejected;
  expect(renderer.active).toBe(0);
});

it("bounds accepted requests and removes queued cancellation without spawning", async () => {
  const renderer = service();
  const first = renderer.layout("svg", source);
  const firstRejected = expect(first).rejects.toThrow(/disposed/);
  const abort = new AbortController();
  const queued = renderer.layout("svg", source, abort.signal);
  const queuedRejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  const rest = [renderer.layout("svg", source), renderer.layout("svg", source)];
  const restRejected = rest.map((task) => expect(task).rejects.toThrow(/disposed/));
  expect(renderer.active).toBe(LIMITS.maxPending);
  const overflow = renderer.layout("svg", source);
  await expect(overflow).rejects.toBeInstanceOf(RenderQueueFullError);
  await expect(overflow).rejects.toThrow(/queue is full/);
  abort.abort();
  await queuedRejected;
  expect(renderer.active).toBe(3);
  expect(ControlledChild.children).toHaveLength(1);
  const disposal = renderer.dispose();
  current().release();
  await Promise.all([firstRejected, ...restRejected, disposal]);
  expect(renderer.active).toBe(0);
  expect(ControlledChild.children).toHaveLength(1);
});

it.each(["before ready", "after ready"])("aborts %s and starts queued work only after exit", async (phase) => {
  const renderer = service();
  const abort = new AbortController();
  const task = renderer.layout("svg", source, abort.signal);
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  const child = current();
  if (phase === "after ready") child.ready();
  const next = renderer.layout("svg", source);
  abort.abort();
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(ControlledChild.children).toHaveLength(1);
  child.result();
  child.release();
  await rejected;
  expect(ControlledChild.children).toHaveLength(2);
  const nextChild = current();
  nextChild.ready();
  nextChild.result();
  nextChild.release();
  await expect(next).resolves.toMatchObject({ width: 1 });
});

it("disposal rejects late successful results and clears resources only after exit", async () => {
  const renderer = service();
  const task = renderer.layout("svg", source);
  const rejected = expect(task).rejects.toThrow(/disposed/);
  const child = current();
  child.ready();
  child.result();
  const disposal = renderer.dispose();
  expect(renderer.active).toBe(1);
  child.release();
  await Promise.all([rejected, disposal]);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(child.stdout.destroy).toHaveBeenCalledOnce();
  expect(renderer.active).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["error", "exit", "close", "invalid", "diagnostic"])(
  "cleans up on child %s and remains usable",
  async (event) => {
    const renderer = service();
    const task = renderer.layout("svg", source);
    const rejected = expect(task).rejects.toThrow();
    const child = current();
    if (event === "error") child.emit("error", new Error("child failed"));
    if (event === "exit" || event === "close") child.emit(event, 1);
    if (event === "invalid") child.emit("message", { type: "unexpected" });
    if (event === "diagnostic") {
      child.ready();
      child.emit("message", { type: "error", error: "\u001b[31munsafe\u0007" });
    }
    child.release();
    await rejected;
    const next = renderer.layout("svg", source);
    current().ready();
    current().result();
    current().release();
    await expect(next).resolves.toMatchObject({ width: 1 });
    expect(renderer.active).toBe(0);
  },
);

it("handles spawn error without an exit event", async () => {
  const renderer = service();
  const task = renderer.layout("svg", source);
  const rejected = expect(task).rejects.toThrow(/spawn/);
  current().pid = undefined;
  current().emit("error", new Error("spawn failed"));
  await rejected;
  expect(renderer.active).toBe(0);
});

it("handles synchronous fork failure without retaining a slot", async () => {
  const renderer = service();
  ControlledChild.fail = true;
  await expect(renderer.layout("svg", source)).rejects.toThrow(/startup failed/);
  expect(renderer.active).toBe(0);
});

it.each(["callback", "throw"])("handles IPC send %s failure and waits for exit", async (mode) => {
  const renderer = service();
  const task = renderer.layout("svg", source);
  const rejected = expect(task).rejects.toThrow(/send failed/);
  const child = current();
  if (mode === "callback")
    child.send.mockImplementationOnce((_request, callback) => {
      callback(new Error("send failed"));
      return false;
    });
  else
    child.send.mockImplementationOnce(() => {
      throw new Error("send failed");
    });
  child.ready();
  expect(renderer.active).toBe(1);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.release();
  await rejected;
});

it("handles a false kill result racing with exit without releasing the slot early", async () => {
  const renderer = service();
  const abort = new AbortController();
  const task = renderer.layout("svg", source, abort.signal);
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  current().kill.mockReturnValueOnce(false);
  abort.abort();
  expect(renderer.active).toBe(1);
  current().release();
  await rejected;
  expect(renderer.active).toBe(0);
});

it("bounds PNG output before publishing it", async () => {
  const renderer = service();
  const task = renderer.raster({ svg: source, width: 1, height: 1, kind: "svg" }, "dark", 1);
  const rejected = expect(task).rejects.toThrow(/4 MiB/);
  current().ready();
  current().emit("message", {
    type: "result",
    value: { png: "A".repeat(4 * Math.ceil(LIMITS.pngBytes / 3) + 4), width: 1, height: 1 },
  });
  current().release();
  await rejected;
  expect(renderer.active).toBe(0);
});

it("snapshots caller-owned layout before queueing", async () => {
  const renderer = service();
  const first = renderer.layout("svg", source);
  const layout = { svg: source, width: 1, height: 1, kind: "svg" as const };
  const second = renderer.raster(layout, "dark", 1);
  const secondRejected = expect(second).rejects.toThrow(/disposed/);
  layout.svg = "changed";
  current().ready();
  current().result();
  current().release();
  await first;
  current().ready();
  expect(current().send).toHaveBeenCalledWith(
    { operation: "raster", layout: { svg: source, width: 1, height: 1, kind: "svg" }, appearance: "dark", widthPx: 1 },
    expect.any(Function),
  );
  const disposal = renderer.dispose();
  current().release();
  await Promise.all([disposal, secondRejected]);
});
