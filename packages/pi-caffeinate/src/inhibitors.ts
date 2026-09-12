import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { CaffeinateMode } from "./settings.js";

export interface InhibitorCommand {
  command: string;
  args: string[];
  description: string;
  releaseOnStdinClose?: boolean;
  custom?: boolean;
  /** Display mode also needs D-Bus because logind idle inhibition misses some compositors. */
  addDbusIdleInhibit?: boolean;
}

export function getInhibitorCommand(mode: CaffeinateMode): InhibitorCommand | undefined {
  const customCommand = process.env.PI_CAFFEINATE_COMMAND?.trim();
  if (customCommand) {
    const [command, ...args] = splitCommand(customCommand);
    if (command) return { command, args, description: `custom command (${command})`, custom: true };
  }
  if (process.platform === "darwin") {
    return parentBoundUnixCommand("caffeinate", macCaffeinateArgs(mode), caffeinateDescription(mode));
  }
  if (process.platform === "linux") {
    if (isWsl() && commandExists("powershell.exe")) {
      return windowsPowerInhibitorCommand("powershell.exe", mode);
    }
    if (commandExists("systemd-inhibit")) {
      const what = mode === "display" ? "idle:sleep" : "sleep";
      return parentBoundUnixCommand(
        "systemd-inhibit",
        [`--what=${what}`, "--who=pi-caffeinate", "--why=Pi agent is running", "--mode=block", "sleep", "infinity"],
        `systemd-inhibit (${formatMode(mode)})`,
        mode === "display",
      );
    }
    if (commandExists("caffeinate")) {
      return parentBoundUnixCommand(
        "caffeinate",
        macCaffeinateArgs(mode),
        caffeinateDescription(mode),
        mode === "display",
      );
    }
  }
  if (process.platform === "win32") return windowsPowerInhibitorCommand("powershell.exe", mode);
  return undefined;
}

function macCaffeinateArgs(mode: CaffeinateMode) {
  return mode === "sleep" ? ["-ims"] : ["-dimsu"];
}

function caffeinateDescription(mode: CaffeinateMode) {
  return `caffeinate (${formatMode(mode)})`;
}

function parentBoundUnixCommand(
  command: string,
  args: string[],
  description: string,
  addDbusIdleInhibit = false,
): InhibitorCommand {
  return {
    command: "sh",
    args: ["-c", unixParentBoundScript(), "pi-caffeinate-watch", String(process.pid), command, ...args],
    description,
    ...(addDbusIdleInhibit ? { addDbusIdleInhibit: true } : {}),
  };
}

function unixParentBoundScript() {
  return `parent=$1; shift; "$@" & child=$!; ( while kill -0 "$parent" 2>/dev/null; do sleep 5; done; kill "$child" 2>/dev/null ) & watcher=$!; cleanup() { kill "$watcher" 2>/dev/null; kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; }; trap 'cleanup; exit 0' INT TERM HUP EXIT; wait "$child"; status=$?; kill "$watcher" 2>/dev/null; trap - EXIT; exit "$status"`;
}

function commandExists(command: string) {
  const searchPath = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of searchPath.split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      if (existsSync(path.join(directory, `${command}${extension}`))) return true;
    }
  }
  return false;
}

export function splitCommand(input: string) {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function windowsPowerInhibitorCommand(command: string, mode: CaffeinateMode): InhibitorCommand {
  return {
    command,
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsInhibitorScript(mode)],
    description: `PowerShell SetThreadExecutionState (${formatMode(mode)})`,
    releaseOnStdinClose: true,
  };
}

export function windowsInhibitorScript(mode: CaffeinateMode) {
  const flags = mode === "sleep" ? "0x80000001" : "0x80000003";
  return `$ErrorActionPreference = 'Stop'; Add-Type -Namespace Native -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'; $flags = [uint32]'${flags}'; $release = [uint32]'0x80000000'; $stdin = [Console]::OpenStandardInput(); $buffer = New-Object byte[] 1; $readTask = $stdin.ReadAsync($buffer, 0, 1); try { while ($true) { [Native.Power]::SetThreadExecutionState($flags) | Out-Null; if ($readTask.Wait(30000)) { break } } } finally { [Native.Power]::SetThreadExecutionState($release) | Out-Null }`;
}

function isWsl() {
  try {
    return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  } catch {
    return false;
  }
}

export function formatMode(mode: CaffeinateMode) {
  return mode === "sleep" ? "system-awake" : "display-awake";
}
