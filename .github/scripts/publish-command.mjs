import { spawn } from "node:child_process";

// This cleanup grace is separate from the caller's registry-readiness budget.
const terminationGrace = 1_000;

export function runPublishCommand(command, args, { cwd, capture = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const ownsGroup = Boolean(signal) && process.platform !== "win32";
    // Do not pass signal to spawn: its AbortError can precede process and pipe closure.
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      detached: ownsGroup,
    });
    let stdout = "";
    let stderr = "";
    let failure;
    let result;
    let aborted = false;
    let stopping = false;
    let killTimer;
    const onStdout = (data) => {
      stdout += data;
    };
    const onStderr = (data) => {
      stderr += data;
    };
    const clearKillTimer = () => {
      clearTimeout(killTimer);
      killTimer = undefined;
    };
    const sendSignal = (value) => {
      if (!child.pid) return false;
      try {
        process.kill(ownsGroup ? -child.pid : child.pid, value);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        failure ??= error;
        return true;
      }
    };
    const finish = () => {
      if (!result || killTimer !== undefined) return;
      clearKillTimer();
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      if (aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else resolve(result);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (!sendSignal("SIGTERM")) return;
      killTimer = setTimeout(() => {
        killTimer = undefined;
        sendSignal("SIGKILL");
        finish();
      }, terminationGrace);
    };
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      stop();
    };
    const onError = (error) => {
      failure ??= error;
    };
    const onClose = (code) => {
      result = { code, stdout, stderr };
      if (ownsGroup) {
        // The leader can close before descendants, including those without captured pipes.
        if (!stopping) stop();
        if (killTimer !== undefined && !sendSignal(0)) clearKillTimer();
      } else {
        clearKillTimer();
      }
      finish();
    };
    child.stdout?.setEncoding("utf8").on("data", onStdout);
    child.stderr?.setEncoding("utf8").on("data", onStderr);
    child.on("error", onError);
    child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
