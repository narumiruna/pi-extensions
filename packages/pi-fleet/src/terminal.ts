import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GhosttyAdapter, GhosttyLaunchError } from "./ghostty.js";
import { TmuxAdapter, TmuxLaunchError } from "./tmux.js";
import { ZellijAdapter, ZellijLaunchError } from "./zellij.js";

export type FleetTerminal = "tmux" | "ghostty" | "zellij";
export type FleetTerminalPreference = "auto" | FleetTerminal;
export type TerminalSplitDirection = "right" | "down" | "left" | "up";

const TMUX_PANE_ID = /^%\d{1,20}$/u;
const ZELLIJ_PANE_ID = /^\d{1,20}$/u;

export interface FleetTerminalPort {
  assertAvailable(signal?: AbortSignal): Promise<string>;
  spawnSplit(options: {
    direction: TerminalSplitDirection;
    cwd: string;
    launcherCommand: string;
    environment: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    isCurrent(): boolean;
  }): Promise<{ terminalId: string; version: string }>;
}

export function normalizeTerminal(value: unknown): FleetTerminal {
  if (value === "tmux" || value === "ghostty" || value === "zellij") return value;
  throw new Error("Pi Fleet terminal must be tmux, ghostty, or zellij");
}

export function resolveTerminalPreference(
  preference: FleetTerminalPreference,
  environment: Readonly<NodeJS.ProcessEnv>,
): FleetTerminal {
  if (preference !== "auto") return normalizeTerminal(preference);
  if (environment.TMUX && TMUX_PANE_ID.test(environment.TMUX_PANE ?? "")) return "tmux";
  if (environment.ZELLIJ && ZELLIJ_PANE_ID.test(environment.ZELLIJ_PANE_ID ?? "")) {
    return "zellij";
  }
  if (environment.TERM_PROGRAM === "ghostty") return "ghostty";
  throw new Error(
    "Pi Fleet could not detect a supported terminal for defaultTerminal auto; run inside tmux, Zellij, or Ghostty, or pin defaultTerminal in Settings",
  );
}

export function terminalLabel(terminal: FleetTerminal): string {
  switch (terminal) {
    case "tmux":
      return "tmux";
    case "ghostty":
      return "Ghostty";
    case "zellij":
      return "Zellij";
  }
}

export function terminalPreferenceLabel(preference: FleetTerminalPreference): string {
  return preference === "auto" ? "Automatic" : terminalLabel(preference);
}

export function createDefaultTerminalPort(pi: ExtensionAPI, terminal: FleetTerminal): FleetTerminalPort {
  const options = {
    execute: async (
      command: string,
      args: string[],
      execution: {
        signal?: AbortSignal;
        timeoutMs: number;
      },
    ) =>
      pi.exec(command, args, {
        ...(execution.signal ? { signal: execution.signal } : {}),
        timeout: execution.timeoutMs,
      }),
  };
  switch (terminal) {
    case "tmux":
      return new TmuxAdapter(options);
    case "ghostty":
      return new GhosttyAdapter(options);
    case "zellij":
      return new ZellijAdapter(options);
  }
}

export function isTerminalLaunchError(
  error: unknown,
): error is GhosttyLaunchError | TmuxLaunchError | ZellijLaunchError {
  return error instanceof GhosttyLaunchError || error instanceof TmuxLaunchError || error instanceof ZellijLaunchError;
}

export function createTerminalLaunchError(
  terminal: FleetTerminal,
  message: string,
  splitCreated: boolean,
  terminalId?: string,
): GhosttyLaunchError | TmuxLaunchError | ZellijLaunchError {
  switch (terminal) {
    case "tmux":
      return new TmuxLaunchError(message, splitCreated, terminalId);
    case "ghostty":
      return new GhosttyLaunchError(message, splitCreated, terminalId);
    case "zellij":
      return new ZellijLaunchError(message, splitCreated, terminalId);
  }
}
