import type { TerminalSplitDirection } from "./terminal.js";

export interface TmuxCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type TmuxCommandExecutor = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<TmuxCommandResult>;

export interface TmuxAdapterOptions {
  execute: TmuxCommandExecutor;
  tmuxEnvironment?: string;
  tmuxPane?: string;
  timeoutMs?: number;
}

export interface SpawnTmuxSplitOptions {
  direction: TerminalSplitDirection;
  cwd: string;
  launcherCommand: string;
  environment: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  isCurrent(): boolean;
}

export class TmuxLaunchError extends Error {
  constructor(
    message: string,
    readonly splitCreated = false,
    readonly terminalId?: string,
  ) {
    super(message);
    this.name = "TmuxLaunchError";
  }
}

const MINIMUM_TMUX_VERSION = { major: 3, minor: 2 } as const;

export class TmuxAdapter {
  private readonly tmuxEnvironment: string | undefined;
  private readonly tmuxPane: string | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: TmuxAdapterOptions) {
    this.tmuxEnvironment = options.tmuxEnvironment ?? process.env.TMUX;
    this.tmuxPane = options.tmuxPane ?? process.env.TMUX_PANE;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async assertAvailable(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal, "tmux availability check aborted");
    if (!this.tmuxEnvironment) {
      throw new TmuxLaunchError("Pi Fleet must be running inside tmux to create a split");
    }
    if (!this.tmuxPane || !/^%\d{1,20}$/u.test(this.tmuxPane)) {
      throw new TmuxLaunchError("Pi Fleet could not identify the current tmux pane");
    }
    let result: TmuxCommandResult;
    try {
      result = await this.options.execute("tmux", ["-V"], {
        ...(signal ? { signal } : {}),
        timeoutMs: this.timeoutMs,
      });
    } catch {
      if (signal?.aborted) throwIfAborted(signal, "tmux availability check aborted");
      throw new TmuxLaunchError("Pi Fleet could not run tmux to check its version");
    }
    throwIfAborted(signal, "tmux availability check aborted");
    if (result.code !== 0 || result.killed) {
      throw new TmuxLaunchError("Pi Fleet could not query the tmux version");
    }
    const version = result.stdout.trim().replace(/^tmux\s+/u, "");
    const parsed = parseVersion(version);
    if (!parsed) throw new TmuxLaunchError("tmux returned an invalid version");
    if (
      parsed.major < MINIMUM_TMUX_VERSION.major ||
      (parsed.major === MINIMUM_TMUX_VERSION.major && parsed.minor < MINIMUM_TMUX_VERSION.minor)
    ) {
      throw new TmuxLaunchError("Pi Fleet requires tmux 3.2 or newer for per-pane launch environments");
    }
    return version;
  }

  async spawnSplit(options: SpawnTmuxSplitOptions): Promise<{ terminalId: string; version: string }> {
    throwIfAborted(options.signal, "tmux split creation aborted");
    validateSpawnOptions(options);
    const version = await this.assertAvailable(options.signal);
    if (!options.isCurrent()) {
      throw new TmuxLaunchError("Pi Fleet session became stale before tmux split creation");
    }
    throwIfAborted(options.signal, "tmux split creation aborted");
    const directionArgs = splitDirectionArgs(options.direction);
    const environmentArgs = Object.entries(options.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    let result: TmuxCommandResult;
    try {
      result = await this.options.execute(
        "tmux",
        [
          "split-window",
          ...directionArgs,
          "-c",
          options.cwd,
          ...environmentArgs,
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          this.tmuxPane as string,
          quoteShell(options.launcherCommand),
        ],
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: this.timeoutMs,
        },
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw new TmuxLaunchError(
          "tmux split creation was cancelled after launch began; a partial split may remain open",
          true,
        );
      }
      throw error;
    }
    const terminalId = /^%\d{1,20}$/u.test(result.stdout.trim()) ? result.stdout.trim() : undefined;
    if (options.signal?.aborted) {
      throw new TmuxLaunchError("tmux created the split after Pi Fleet launch was cancelled", true, terminalId);
    }
    if (result.killed) {
      throw new TmuxLaunchError("tmux split creation timed out; a partial split may remain open", true, terminalId);
    }
    if (result.code !== 0) {
      throw new TmuxLaunchError("tmux could not create the Pi Fleet split");
    }
    if (!terminalId) {
      throw new TmuxLaunchError("tmux created a split but returned no pane identity", true);
    }
    if (!options.isCurrent()) {
      throw new TmuxLaunchError("Pi Fleet session became stale after tmux created the split", true, terminalId);
    }
    return { terminalId, version };
  }
}

function splitDirectionArgs(direction: TerminalSplitDirection): string[] {
  switch (direction) {
    case "right":
      return ["-h"];
    case "down":
      return ["-v"];
    case "left":
      return ["-h", "-b"];
    case "up":
      return ["-v", "-b"];
  }
}

function validateSpawnOptions(options: SpawnTmuxSplitOptions): void {
  if (
    options.direction !== "right" &&
    options.direction !== "down" &&
    options.direction !== "left" &&
    options.direction !== "up"
  ) {
    throw new TmuxLaunchError("Pi Fleet split direction is invalid");
  }
  for (const [label, value, maxBytes] of [
    ["working directory", options.cwd, 4_096],
    ["launcher command", options.launcherCommand, 4_096],
  ] as const) {
    if (!value || value.includes("\0") || Buffer.byteLength(value) > maxBytes) {
      throw new TmuxLaunchError(`Pi Fleet ${label} is invalid`);
    }
  }
  let environmentBytes = 0;
  for (const [key, value] of Object.entries(options.environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key) || value.includes("\0")) {
      throw new TmuxLaunchError("Pi Fleet launch environment is invalid");
    }
    environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 1;
  }
  if (environmentBytes > 24 * 1024) {
    throw new TmuxLaunchError("Pi Fleet launch environment is too large");
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseVersion(value: string): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)(?:[a-z]|[-+].*)?$/u.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  const error = new Error(message);
  error.name = "AbortError";
  throw error;
}
