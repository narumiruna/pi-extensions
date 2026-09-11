import type { TerminalSplitDirection } from "./terminal.js";

export type GhosttySplitDirection = TerminalSplitDirection;

export interface GhosttyCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type GhosttyCommandExecutor = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<GhosttyCommandResult>;

export interface GhosttyAdapterOptions {
  execute: GhosttyCommandExecutor;
  platform?: NodeJS.Platform;
  termProgram?: string;
  timeoutMs?: number;
}

export interface SpawnGhosttySplitOptions {
  direction: TerminalSplitDirection;
  cwd: string;
  launcherCommand: string;
  environment: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  isCurrent(): boolean;
}

export class GhosttyLaunchError extends Error {
  constructor(
    message: string,
    readonly splitCreated = false,
    readonly terminalId?: string,
  ) {
    super(message);
    this.name = "GhosttyLaunchError";
  }
}

const VERSION_SCRIPT = 'tell application "Ghostty" to get version';
const SPLIT_SCRIPT = `on run argv
	if (count of argv) < 3 then error "Pi Fleet launch arguments are incomplete"
	set splitDirection to item 1 of argv
	set launchDirectory to item 2 of argv
	set launchCommand to item 3 of argv
	set launchEnvironment to {}
	if (count of argv) > 3 then set launchEnvironment to items 4 thru -1 of argv

	tell application "Ghostty"
		if (count of windows) is 0 then error "Focused terminal is unavailable"
		set activeWindow to front window
		set activeTab to selected tab of activeWindow
		set currentTerminal to focused terminal of activeTab
		if currentTerminal is missing value then error "Focused terminal is unavailable"

		set cfg to new surface configuration
		set initial working directory of cfg to launchDirectory
		set command of cfg to launchCommand
		set environment variables of cfg to launchEnvironment
		set wait after command of cfg to true

		if splitDirection is "right" then
			set childTerminal to split currentTerminal direction right with configuration cfg
		else if splitDirection is "down" then
			set childTerminal to split currentTerminal direction down with configuration cfg
		else if splitDirection is "left" then
			set childTerminal to split currentTerminal direction left with configuration cfg
		else if splitDirection is "up" then
			set childTerminal to split currentTerminal direction up with configuration cfg
		else
			error "Pi Fleet split direction is invalid"
		end if
		return id of childTerminal
	end tell
end run`;

export class GhosttyAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly termProgram: string | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: GhosttyAdapterOptions) {
    this.platform = options.platform ?? process.platform;
    this.termProgram = options.termProgram ?? process.env.TERM_PROGRAM;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async assertAvailable(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal, "Ghostty availability check aborted");
    if (this.platform !== "darwin") {
      throw new GhosttyLaunchError("Ghostty split automation currently requires macOS");
    }
    if (this.termProgram !== "ghostty") {
      throw new GhosttyLaunchError("Pi Fleet must run in the current Ghostty terminal to create a split");
    }
    const result = await this.options.execute("osascript", ["-e", VERSION_SCRIPT], {
      ...(signal ? { signal } : {}),
      timeoutMs: this.timeoutMs,
    });
    throwIfAborted(signal, "Ghostty availability check aborted");
    if (result.code !== 0 || result.killed) throw ghosttyCommandError(result, false);
    const version = result.stdout.trim();
    const parsed = parseVersion(version);
    if (!parsed) throw new GhosttyLaunchError("Ghostty returned an invalid version");
    if (parsed.major < 1 || (parsed.major === 1 && parsed.minor < 3)) {
      throw new GhosttyLaunchError("Pi Fleet requires Ghostty 1.3 or newer for AppleScript splits");
    }
    return version;
  }

  async spawnSplit(options: SpawnGhosttySplitOptions): Promise<{ terminalId: string; version: string }> {
    throwIfAborted(options.signal, "Ghostty split creation aborted");
    validateSpawnOptions(options);
    const version = await this.assertAvailable(options.signal);
    if (!options.isCurrent()) throw new GhosttyLaunchError("Pi Fleet session became stale before split creation");
    throwIfAborted(options.signal, "Ghostty split creation aborted");
    const environment = Object.entries(options.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`);
    let result: GhosttyCommandResult;
    try {
      result = await this.options.execute(
        "osascript",
        ["-e", SPLIT_SCRIPT, "--", options.direction, options.cwd, options.launcherCommand, ...environment],
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: this.timeoutMs,
        },
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw new GhosttyLaunchError(
          "Ghostty split creation was cancelled after launch began; a partial split may remain open",
          true,
        );
      }
      throw error;
    }
    if (result.code !== 0 || result.killed) {
      if (options.signal?.aborted) {
        throw new GhosttyLaunchError(
          "Ghostty split creation was cancelled after launch began; a partial split may remain open",
          true,
        );
      }
      throw ghosttyCommandError(result, false);
    }
    const terminalId = result.stdout.trim();
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(terminalId)) {
      throw new GhosttyLaunchError("Ghostty created a split but returned no terminal identity", true);
    }
    if (options.signal?.aborted) {
      throw new GhosttyLaunchError("Ghostty created the split after Pi Fleet launch was cancelled", true, terminalId);
    }
    if (!options.isCurrent()) {
      throw new GhosttyLaunchError("Pi Fleet session became stale after Ghostty created the split", true, terminalId);
    }
    return { terminalId, version };
  }
}

function validateSpawnOptions(options: SpawnGhosttySplitOptions): void {
  if (
    options.direction !== "right" &&
    options.direction !== "down" &&
    options.direction !== "left" &&
    options.direction !== "up"
  ) {
    throw new GhosttyLaunchError("Pi Fleet split direction is invalid");
  }
  for (const [label, value, maxBytes] of [
    ["working directory", options.cwd, 4_096],
    ["launcher command", options.launcherCommand, 4_096],
  ] as const) {
    if (!value || value.includes("\0") || Buffer.byteLength(value) > maxBytes) {
      throw new GhosttyLaunchError(`Pi Fleet ${label} is invalid`);
    }
  }
  let environmentBytes = 0;
  for (const [key, value] of Object.entries(options.environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key) || value.includes("\0")) {
      throw new GhosttyLaunchError("Pi Fleet launch environment is invalid");
    }
    environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 1;
  }
  if (environmentBytes > 24 * 1024) {
    throw new GhosttyLaunchError("Pi Fleet launch environment is too large");
  }
}

function ghosttyCommandError(result: GhosttyCommandResult, splitCreated: boolean): GhosttyLaunchError {
  const detail = `${result.stderr}\n${result.stdout}`;
  if (/not authorized|apple events|-1743|automation/iu.test(detail)) {
    return new GhosttyLaunchError(
      "Ghostty Automation permission was denied; allow Pi or your terminal host to control Ghostty in macOS Privacy & Security settings",
      splitCreated,
    );
  }
  if (/focused terminal|front window|selected tab/iu.test(detail)) {
    return new GhosttyLaunchError("Ghostty has no focused terminal available for the new split", splitCreated);
  }
  return new GhosttyLaunchError("Ghostty could not create the Pi Fleet split", splitCreated);
}

function parseVersion(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  const error = new Error(message);
  error.name = "AbortError";
  throw error;
}
