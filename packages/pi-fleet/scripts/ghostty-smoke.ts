import { spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { GhosttyAdapter } from "../src/ghostty.js";
import { launchEnvelopeEnvironment } from "../src/launch-envelope.js";
import { createPiLauncher } from "../src/launcher.js";
import { resolvePiInvocation } from "../src/pi-invocation.js";
import {
  createGroup,
  DEFAULT_MESSAGE_TTL_MS,
  FLEET_PROTOCOL_VERSION,
  type FleetMessage,
  formatInvite,
} from "../src/protocol.js";
import { FleetTransport } from "../src/transport.js";

const packageDirectory = await realpath(process.cwd());
const parentSessionId = `smoke-parent-${process.pid}`;
const launchId = `smoke-launch-${process.pid}`;
const kickoffCapability = `smoke-kickoff-capability-${process.pid}`;
const group = createGroup();
let replyResolve!: (message: FleetMessage) => void;
const replyPromise = new Promise<FleetMessage>((resolve) => {
  replyResolve = resolve;
});
const parent = new FleetTransport({
  group,
  peer: {
    protocolVersion: FLEET_PROTOCOL_VERSION,
    sessionId: parentSessionId,
    name: "Pi Fleet smoke parent",
    cwd: packageDirectory,
    pid: process.pid,
    acceptsRequests: true,
  },
  onMessage: async (message) => {
    if (message.mode === "reply") replyResolve(message);
  },
});
const ghostty = new GhosttyAdapter({ execute: executeCommand });
let terminalId: string | undefined;
let runtimeDirectory: string | undefined;
let launcher: Awaited<ReturnType<typeof createPiLauncher>> | undefined;
try {
  await parent.start();
  const directory = parent.endpointManifest?.directory;
  if (!directory) throw new Error("smoke parent runtime directory is unavailable");
  runtimeDirectory = directory;
  const args = ["--no-extensions", "-e", packageDirectory, "--no-session", "--name", "Pi Fleet Ghostty smoke child"];
  if (process.env.PI_PROVIDER && process.env.PI_MODEL) {
    args.push("--provider", process.env.PI_PROVIDER, "--model", process.env.PI_MODEL);
  }
  if (process.env.PI_REASONING_LEVEL) args.push("--thinking", process.env.PI_REASONING_LEVEL);
  launcher = await createPiLauncher(resolvePiInvocation(args), directory);
  const split = await ghostty.spawnSplit({
    direction: "right",
    cwd: packageDirectory,
    launcherCommand: launcher.command,
    environment: launchEnvelopeEnvironment({
      invite: formatInvite(group.secret),
      parentSessionId,
      launchId,
      kickoffCapability,
      childName: "Pi Fleet Ghostty smoke child",
      acceptsRequests: true,
      ...(process.env.PI_PROVIDER && process.env.PI_MODEL
        ? {
            model: {
              provider: process.env.PI_PROVIDER,
              id: process.env.PI_MODEL,
              ...(isThinkingLevel(process.env.PI_REASONING_LEVEL)
                ? { thinkingLevel: process.env.PI_REASONING_LEVEL }
                : {}),
            },
          }
        : {}),
    }),
    isCurrent: () => true,
  });
  terminalId = split.terminalId;
  const child = await waitForChild(parent, launchId, 15_000);
  await launcher.cleanup();
  launcher = undefined;
  const notifyIssuedAt = Date.now();
  const notify: FleetMessage = {
    id: `smoke-notify-${process.pid}`,
    fromSessionId: parentSessionId,
    fromName: "Pi Fleet smoke parent",
    fromCwd: packageDirectory,
    toSessionId: child.sessionId,
    mode: "notify",
    text: "Pi Fleet deterministic Ghostty smoke notify.",
    issuedAt: notifyIssuedAt,
    expiresAt: notifyIssuedAt + DEFAULT_MESSAGE_TTL_MS,
  };
  const notifyAck = await parent.send(child.sessionId, notify);
  if (!notifyAck.accepted) throw new Error(`child rejected smoke notify: ${notifyAck.error}`);
  const kickoffId = `smoke-kickoff-${process.pid}`;
  const kickoffIssuedAt = Date.now();
  const kickoff: FleetMessage = {
    id: kickoffId,
    fromSessionId: parentSessionId,
    fromName: "Pi Fleet smoke parent",
    fromCwd: packageDirectory,
    toSessionId: child.sessionId,
    mode: "kickoff",
    text: `Use session_bus action reply with targetSessionId ${parentSessionId}, replyTo ${kickoffId}, and message smoke-reply. Do not perform any other work.`,
    issuedAt: kickoffIssuedAt,
    expiresAt: kickoffIssuedAt + DEFAULT_MESSAGE_TTL_MS,
    launchId,
  };
  const kickoffAck = await parent.send(child.sessionId, kickoff, undefined, {
    kickoffCapability,
  });
  if (!kickoffAck.accepted) throw new Error(`child rejected smoke kickoff: ${kickoffAck.error}`);
  const reply = await withTimeout(replyPromise, 90_000, "child session reply timed out");
  if (reply.replyTo !== kickoffId || reply.text.trim() !== "smoke-reply") {
    throw new Error("child returned an unexpected smoke reply");
  }
  process.stdout.write(
    `${JSON.stringify({
      ghosttyVersion: split.version,
      terminalId: split.terminalId,
      childSessionId: child.sessionId,
      childCwd: child.cwd,
      notifyAccepted: true,
      kickoffAccepted: true,
      replyReceived: true,
      replyTriggeredParentTurn: false,
    })}\n`,
  );
} finally {
  await launcher?.cleanup();
  await parent.stop();
  if (terminalId) await closeGhosttyTerminal(terminalId).catch(() => undefined);
  if (runtimeDirectory) await waitForEndpointCleanup(runtimeDirectory, 15_000);
}

async function waitForChild(transport: FleetTransport, expectedLaunchId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const peers = await transport.listPeers();
    const child = peers.find((peer) => peer.launchId === expectedLaunchId);
    if (child) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Ghostty child readiness timed out after ${timeoutMs}ms`);
}

async function waitForEndpointCleanup(directory: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const entries = await readdir(directory).catch(() => [] as string[]);
    if (!entries.some((entry) => entry.endsWith(".json") || entry.endsWith(".sock"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Ghostty smoke child did not clean its endpoint after close");
}

async function closeGhosttyTerminal(id: string): Promise<void> {
  const script = `on run argv
	tell application "Ghostty"
		set targetId to item 1 of argv
		set matches to every terminal whose id is targetId
		if (count of matches) > 0 then close item 1 of matches
	end tell
end run`;
  const result = await executeCommand("osascript", ["-e", script, "--", id], { timeoutMs: 5_000 });
  if (result.code !== 0) throw new Error("could not close the Ghostty smoke terminal");
}

function executeCommand(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-16_384);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ stdout, stderr, code: code ?? 1, killed: timedOut || signal !== null });
    });
  });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isThinkingLevel(
  value: string | undefined,
): value is "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}
