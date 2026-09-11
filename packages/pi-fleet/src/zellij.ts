import type { TerminalSplitDirection } from "./terminal.js";

export interface ZellijCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type ZellijCommandExecutor = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<ZellijCommandResult>;

export interface ZellijAdapterOptions {
  execute: ZellijCommandExecutor;
  zellijEnvironment?: string;
  zellijPaneId?: string;
  timeoutMs?: number;
}

export interface SpawnZellijSplitOptions {
  direction: TerminalSplitDirection;
  cwd: string;
  launcherCommand: string;
  environment: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  isCurrent(): boolean;
}

export class ZellijLaunchError extends Error {
  constructor(
    message: string,
    readonly splitCreated = false,
    readonly terminalId?: string,
  ) {
    super(message);
    this.name = "ZellijLaunchError";
  }
}

const MINIMUM_ZELLIJ_VERSION = { major: 0, minor: 44, patch: 0 } as const;

export class ZellijAdapter {
  private readonly zellijEnvironment: string | undefined;
  private readonly zellijPaneId: string | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: ZellijAdapterOptions) {
    this.zellijEnvironment = options.zellijEnvironment ?? process.env.ZELLIJ;
    this.zellijPaneId = options.zellijPaneId ?? process.env.ZELLIJ_PANE_ID;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async assertAvailable(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal, "Zellij availability check aborted");
    if (!this.zellijEnvironment) {
      throw new ZellijLaunchError("Pi Fleet must be running inside Zellij to create a split");
    }
    if (!this.zellijPaneId || !/^\d{1,20}$/u.test(this.zellijPaneId)) {
      throw new ZellijLaunchError("Pi Fleet could not identify the current Zellij pane");
    }
    let result: ZellijCommandResult;
    try {
      result = await this.options.execute("zellij", ["--version"], {
        ...(signal ? { signal } : {}),
        timeoutMs: this.timeoutMs,
      });
    } catch {
      if (signal?.aborted) throwIfAborted(signal, "Zellij availability check aborted");
      throw new ZellijLaunchError("Pi Fleet could not run Zellij to check its version");
    }
    throwIfAborted(signal, "Zellij availability check aborted");
    if (result.code !== 0 || result.killed) {
      throw new ZellijLaunchError("Pi Fleet could not query the Zellij version");
    }
    const version = result.stdout.trim().replace(/^zellij\s+/u, "");
    const parsed = parseVersion(version);
    if (!parsed) throw new ZellijLaunchError("Zellij returned an invalid version");
    if (compareVersion(parsed, MINIMUM_ZELLIJ_VERSION) < 0) {
      throw new ZellijLaunchError("Pi Fleet requires Zellij 0.44 or newer for pane identity and placement");
    }
    return version;
  }

  async spawnSplit(options: SpawnZellijSplitOptions): Promise<{ terminalId: string; version: string }> {
    throwIfAborted(options.signal, "Zellij split creation aborted");
    validateSpawnOptions(options);
    const version = await this.assertAvailable(options.signal);
    if (!options.isCurrent()) {
      throw new ZellijLaunchError("Pi Fleet session became stale before Zellij pane creation");
    }
    throwIfAborted(options.signal, "Zellij split creation aborted");
    const nativeDirection = options.direction === "down" || options.direction === "up" ? "down" : "right";
    let result: ZellijCommandResult;
    try {
      result = await this.options.execute(
        "zellij",
        ["action", "new-pane", "--direction", nativeDirection, "--cwd", options.cwd, "--", options.launcherCommand],
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: this.timeoutMs,
        },
      );
    } catch {
      if (options.signal?.aborted) {
        throw new ZellijLaunchError(
          "Zellij pane creation was cancelled after launch began; a partial pane may remain open",
          true,
        );
      }
      throw new ZellijLaunchError("Zellij could not create the Pi Fleet pane");
    }
    const terminalId = /^terminal_\d{1,20}$/u.test(result.stdout.trim()) ? result.stdout.trim() : undefined;
    if (options.signal?.aborted) {
      throw new ZellijLaunchError("Zellij created the pane after Pi Fleet launch was cancelled", true, terminalId);
    }
    if (result.killed) {
      throw new ZellijLaunchError("Zellij pane creation timed out; a partial pane may remain open", true, terminalId);
    }
    if (result.code !== 0) {
      throw new ZellijLaunchError("Zellij could not create the Pi Fleet pane", terminalId !== undefined, terminalId);
    }
    if (!terminalId) {
      throw new ZellijLaunchError("Zellij created a pane but returned no terminal identity", true);
    }
    if (!options.isCurrent()) {
      throw new ZellijLaunchError("Pi Fleet session became stale after Zellij created the pane", true, terminalId);
    }
    if (options.direction === "left" || options.direction === "up") {
      await this.placePane(options.direction, terminalId, options.signal);
    }
    if (options.signal?.aborted) {
      throw new ZellijLaunchError("Zellij created the pane after Pi Fleet launch was cancelled", true, terminalId);
    }
    if (!options.isCurrent()) {
      throw new ZellijLaunchError("Pi Fleet session became stale after Zellij created the pane", true, terminalId);
    }
    return { terminalId, version };
  }

  private async placePane(direction: "left" | "up", terminalId: string, signal?: AbortSignal): Promise<void> {
    let result: ZellijCommandResult;
    try {
      result = await this.options.execute("zellij", ["action", "move-pane", "--pane-id", terminalId, direction], {
        ...(signal ? { signal } : {}),
        timeoutMs: this.timeoutMs,
      });
    } catch {
      if (signal?.aborted) throw placementCancellationError(terminalId);
      throw new ZellijLaunchError(
        `Zellij created the Pi Fleet pane, but ${direction} placement failed`,
        true,
        terminalId,
      );
    }
    if (signal?.aborted) throw placementCancellationError(terminalId);
    if (result.killed || result.code !== 0) {
      throw new ZellijLaunchError(
        `Zellij created the Pi Fleet pane, but ${direction} placement failed`,
        true,
        terminalId,
      );
    }
  }
}

function placementCancellationError(terminalId: string): ZellijLaunchError {
  return new ZellijLaunchError(
    "Zellij pane placement was cancelled after creation; the partial pane remains open",
    true,
    terminalId,
  );
}

function validateSpawnOptions(options: SpawnZellijSplitOptions): void {
  if (
    options.direction !== "right" &&
    options.direction !== "down" &&
    options.direction !== "left" &&
    options.direction !== "up"
  ) {
    throw new ZellijLaunchError("Pi Fleet split direction is invalid");
  }
  for (const [label, value, maxBytes] of [
    ["working directory", options.cwd, 4_096],
    ["launcher command", options.launcherCommand, 4_096],
  ] as const) {
    if (!value || value.includes("\0") || Buffer.byteLength(value) > maxBytes) {
      throw new ZellijLaunchError(`Pi Fleet ${label} is invalid`);
    }
  }
  if (Object.keys(options.environment).length > 0) {
    throw new ZellijLaunchError("Pi Fleet Zellij launch environment must use the private launcher");
  }
}

function parseVersion(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersion(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  const error = new Error(message);
  error.name = "AbortError";
  throw error;
}
