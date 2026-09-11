import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import type { InhibitorCommand } from "./inhibitors.js";

export function startInhibitorProcess(
  command: InhibitorCommand,
  onError: (error: Error) => void,
  onUnexpectedExit: (description: string) => void,
): ChildProcess {
  const child = spawn(command.command, command.args, {
    detached: false,
    stdio: [command.releaseOnStdinClose ? "pipe" : "ignore", "pipe", "pipe"],
  });
  child.once("error", onError);
  child.once("exit", (code, signal) => onUnexpectedExit(formatExit(code, signal)));
  return child;
}

export function stopInhibitorProcess(child: ChildProcess, command: InhibitorCommand | undefined) {
  child.removeAllListeners("exit");
  child.removeAllListeners("error");
  if (child.killed) return;

  if (command?.releaseOnStdinClose && child.stdin && !child.stdin.destroyed) {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
      }, 2000);
      killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
    }
  } else if (process.platform === "win32") {
    child.kill();
  } else {
    child.kill("SIGTERM");
  }
}

function formatExit(code: number | null, signal: NodeJS.Signals | null) {
  if (signal) return `signal ${signal}`;
  return `code ${code ?? "unknown"}`;
}
