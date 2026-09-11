import { spawn } from "node:child_process";
import type { WorkspaceExec } from "./types.js";

const FORCE_KILL_DELAY_MS = 250;

export const execWorkspaceCommand: WorkspaceExec = async (command, args, options) =>
  new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ stdout: "", stderr: "", code: 1, killed: true });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: explicitEnvironment(options.environment),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ stdout: "", stderr: "", code: 1, killed: false });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let killed = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", terminate);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        killed,
      });
    };

    const signalProcessTree = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          child.kill(signal);
          return;
        }
      }
      try {
        const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => child.kill(signal));
        killer.unref();
      } catch {
        child.kill(signal);
      }
    };

    function terminate() {
      if (killed || settled) return;
      killed = true;
      signalProcessTree("SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalProcessTree("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(1);
      }, FORCE_KILL_DELAY_MS);
    }

    const collect = (target: Buffer[]) => (data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const remaining = Math.max(0, options.maxOutputBytes - outputBytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) terminate();
    };

    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", () => {
      if (!killed) finish(1);
    });
    child.once("close", (code) => {
      if (!killed) finish(code ?? 1);
    });
    options.signal?.addEventListener("abort", terminate, { once: true });
    if (options.signal?.aborted) terminate();
    timeoutTimer = setTimeout(terminate, options.timeout);
  });

function explicitEnvironment(source: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value === undefined || value.includes("\0")) {
      continue;
    }
    Object.defineProperty(result, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}
