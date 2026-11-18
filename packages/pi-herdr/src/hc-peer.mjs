import { constants } from "node:fs";
import * as files from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

export const MAX_TASK_BYTES = 32 * 1024;
// JSON escaping can double a valid 32 KiB task before the bounded handoff overhead.
export const MAX_OUTPUT_BYTES = 128 * 1024;
export const RPC_TIMEOUT_MS = 5000;
export const WAIT_TIMEOUT_MS = 35000;
export const SEND_TIMEOUT_MS = 70000;
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validName = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(value);
const identifier = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  value.length <= 256 &&
  !controls.test(value);
// This helper starts local terminals only; native IDs use a digit then base-30 consonants/digits.
export const terminalAddress = (value) => identifier(value) && /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/u.test(value);
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
const sameArgv = (left, right) => left.length === right.length && left.every((arg, index) => arg === right[index]);
const requiredMethods = ["terminal.get", "terminal.run", "terminal.wait", "terminal.send"];

// Only fixed helper-owned messages may cross the public error boundary.
class SafeError extends Error {}
function fail(message) {
  throw new SafeError(message);
}
function checkCancelled(signal) {
  if (signal?.aborted) fail("Operation cancelled; server-side changes may have occurred");
}
function absolutePath(path, paths = { isAbsolute }) {
  return typeof path === "string" && paths.isAbsolute(path) && !controls.test(path);
}
function inside(root, path, paths = { relative, isAbsolute, sep }) {
  const local = paths.relative(root, path);
  return local === "" || (local !== ".." && !local.startsWith(`..${paths.sep}`) && !paths.isAbsolute(local));
}

export function checkPeerText(text) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    Buffer.byteLength(text) > MAX_TASK_BYTES ||
    controls.test(text.replace(/[\t\r\n]/gu, ""))
  )
    fail("Peer text must be nonempty and at most 32768 UTF-8 bytes, without terminal controls except tab/CR/newline");
}

/** Resolve only; never run a candidate, consult PATH, or execute Git. */
export async function resolveTrustedExecutables(
  piCli,
  { cwd = process.cwd(), execPath = process.execPath, platform = process.platform, signal, fs = files } = {},
) {
  const paths = platform === "win32" ? win32 : { dirname, isAbsolute, relative, resolve, sep };
  if (![cwd, execPath, piCli].every((path) => absolutePath(path, paths))) {
    fail("The cwd, Node runtime, and Pi CLI must be absolute paths without terminal controls");
  }
  checkCancelled(signal);
  let directory = await fs.realpath(cwd);
  checkCancelled(signal);
  if (!absolutePath(directory, paths)) fail("Invalid canonical cwd");
  let project = directory;
  while (true) {
    try {
      await fs.stat(paths.resolve(directory, ".git"));
      project = directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    checkCancelled(signal);
    const parent = paths.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  async function canonical(path, executable) {
    const resolved = await fs.realpath(path);
    checkCancelled(signal);
    if (!absolutePath(resolved, paths) || inside(project, resolved, paths)) {
      fail("Node and the Pi CLI must resolve outside the topmost cwd Git ancestor (or cwd without Git)");
    }
    // The already running Node bootstrap must itself be trusted. This cannot undo its execution.
    if (executable && platform === "win32" && !/\.exe$/iu.test(resolved)) fail("Node must be a native executable");
    const info = await fs.stat(resolved);
    checkCancelled(signal);
    if (!info.isFile()) fail("Node and the Pi CLI must be regular files");
    await fs.access(resolved, executable && platform !== "win32" ? constants.X_OK : constants.R_OK);
    checkCancelled(signal);
    // Native template lookup excludes '/', not '\\'; absolute Windows argv must contain '/'.
    return platform === "win32" ? resolved.replaceAll("\\", "/") : resolved;
  }
  const node = await canonical(execPath, true);
  checkCancelled(signal);
  const cli = await canonical(piCli, false);
  checkCancelled(signal);
  return { node, piCli: cli };
}

/** Select this package's built directory, or the source entry for an unbuilt Git install. */
export async function checkResources(root, skill, { signal, fs = files } = {}) {
  if (!absolutePath(root) || !absolutePath(skill)) fail("Invalid package resources");
  checkCancelled(signal);
  const canonicalRoot = await fs.realpath(root);
  checkCancelled(signal);
  const canonicalSkill = await fs.realpath(skill);
  checkCancelled(signal);
  if (
    !absolutePath(canonicalRoot) ||
    !absolutePath(canonicalSkill) ||
    canonicalSkill !== resolve(canonicalRoot, "skills/pi-herdr")
  )
    fail("The skill must belong to this package");
  async function regular(path, boundary) {
    const canonical = await fs.realpath(path);
    checkCancelled(signal);
    if (!absolutePath(canonical) || !inside(boundary, canonical)) fail("Resource escaped this package");
    const info = await fs.stat(canonical);
    checkCancelled(signal);
    if (!info.isFile()) fail("Resource must be a regular file");
    return canonical;
  }
  await regular(resolve(canonicalSkill, "SKILL.md"), canonicalSkill);
  checkCancelled(signal);
  for (const entry of ["dist/index.ts", "src/index.ts"]) {
    try {
      const path = await regular(resolve(canonicalRoot, entry), canonicalRoot);
      checkCancelled(signal);
      return entry === "dist/index.ts" ? canonicalRoot : path;
    } catch (error) {
      checkCancelled(signal);
      if (error.code !== "ENOENT") throw error;
    }
  }
  fail("Missing package entrypoint");
}

// This is a sampled process identity, not authenticated Pi/session/foreground ownership.
export function identity(value) {
  if (
    !record(value) ||
    !terminalAddress(value.address) ||
    value.state !== "live" ||
    !natural(value.created_ms) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    value.pid > 0xffffffff ||
    !Array.isArray(value.argv) ||
    value.argv.length === 0 ||
    value.argv.some((arg) => typeof arg !== "string") ||
    !value.argv[0].trim()
  )
    fail("Missing or malformed live terminal identity");
  return { address: value.address, created: value.created_ms, pid: value.pid, argv: [...value.argv] };
}
export function sameIdentity(value, expected) {
  const actual = identity(value);
  if (
    actual.address !== expected.address ||
    actual.created !== expected.created ||
    actual.pid !== expected.pid ||
    !sameArgv(actual.argv, expected.argv)
  )
    fail("Observed terminal identity changed; inspect the known terminal before retrying");
}
export function reportedPi(value, states) {
  if (
    value.reported !== true ||
    !record(value.status) ||
    value.status.app !== "pi" ||
    !states.includes(value.status.state)
  ) {
    fail("Terminal has no current safe Pi status report; task not submitted");
  }
}
function targetFacts(value, expected, { name, cwd, argv, origin }, ready) {
  sameIdentity(value, expected);
  if (
    value.name !== name ||
    value.cwd !== cwd ||
    !sameArgv(value.argv, argv) ||
    value.parent !== origin ||
    value.die_with_parent !== false ||
    value.keep !== false ||
    value.rm !== false
  )
    fail("Peer launch facts changed or do not match the requested independent terminal");
  if (ready) reportedPi(value, ["idle"]);
}
export function coreIdentity(value) {
  if (
    !record(value) ||
    value.generation !== 1 ||
    value.framed !== false ||
    !identifier(value.core?.id) ||
    !Array.isArray(value.methods) ||
    requiredMethods.some((method) => !value.methods.includes(method))
  )
    fail("Unsupported or malformed hc hello");
  return value.core.id;
}
function validateWait(value, address) {
  if (
    !record(value) ||
    value.terminal !== address ||
    typeof value.ended !== "boolean" ||
    !natural(value.turn) ||
    !["status", "timeout", "message", "exit"].includes(value.reason) ||
    (value.status != null && typeof value.status !== "string") ||
    !Array.isArray(value.children) ||
    value.children.length !== 0
  )
    fail("Unknown readiness wait result; inspect the known terminal");
  // A message or timeout is not readiness. A fresh get below decides whether sending is safe.
  if (value.reason === "exit") fail("Peer exited during readiness wait; task not submitted");
}
export function validateSend(value) {
  // Public SendResult has no address/terminal. Do not invent an identity acknowledgement.
  if (
    !record(value) ||
    !natural(value.turn) ||
    (value.status != null && value.status !== "idle") ||
    (value.started != null && typeof value.started !== "boolean")
  )
    fail("Task submission acknowledgement is ambiguous; never retry automatically");
}

export class SpawnHcPeerError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "SpawnHcPeerError";
    this.details = { ...details, error: message };
  }
}

/** Bound to an existing connection; the caller must obtain explicit operator confirmation on it. */
export async function spawnHcPeer(
  options,
  {
    originId,
    cwd = process.cwd(),
    signal,
    request,
    approve,
    assertResources = checkResources,
    resolveExecutables = resolveTrustedExecutables,
    root,
    skill,
  },
) {
  const known = { ...(validName(options?.name) ? { name: options.name } : {}), submissionAttempted: false };
  try {
    if (!validName(options?.name)) fail("Name must match [a-z][a-z0-9_-]{0,31}");
    if (!terminalAddress(originId)) fail("Invalid inherited hc terminal address");
    if (!absolutePath(cwd)) fail("An absolute cwd without terminal controls is required");
    if (!absolutePath(options.piCli)) fail("The active Pi CLI must be an absolute path without terminal controls");
    checkCancelled(signal);
    const task = options.text;
    checkPeerText(task);
    let extension;
    try {
      extension = await assertResources(root, skill, { signal });
    } catch {
      checkCancelled(signal);
      fail("Same-package skill SKILL.md and a package entrypoint (dist/index.ts or src/index.ts) are required");
    }
    checkCancelled(signal);
    if (!absolutePath(extension) || !absolutePath(skill)) fail("Invalid package resource paths");
    let executables;
    try {
      executables = await resolveExecutables(options.piCli, { cwd, signal });
    } catch (error) {
      checkCancelled(signal);
      if (error instanceof SafeError) throw error;
      fail("Cannot verify trusted absolute external Node and Pi CLI files");
    }
    checkCancelled(signal);
    if (!absolutePath(executables?.node) || !absolutePath(executables?.piCli)) fail("Invalid executable paths");
    const argv = [executables.node, executables.piCli, "-e", extension, "--skill", skill];

    async function call(method, params, { timeoutMs = RPC_TIMEOUT_MS, capture } = {}) {
      checkCancelled(signal);
      let result;
      try {
        result = await request(method, params, { timeoutMs });
      } catch {
        checkCancelled(signal);
        fail(`${method} failed or timed out; inspect known state before retrying`);
      }
      capture?.(result);
      checkCancelled(signal);
      return result;
    }
    // core.id survives core restarts; it is reset on state wipe, not a process/session token.
    const core = coreIdentity(await call("hello", { generation: 1 }));
    const first = await call("terminal.get", { terminal: originId });
    const origin = identity(first);
    if (origin.address !== originId) fail("Origin response did not match the inherited terminal address");
    reportedPi(first, ["idle", "working", "done"]);
    known.originAddress = origin.address;
    async function verifyOrigin() {
      if (coreIdentity(await call("hello", { generation: 1 })) !== core) fail("hc core identity changed");
      // No caller: read-only inspection must not mark unrelated child news as seen.
      const current = await call("terminal.get", { terminal: origin.address });
      sameIdentity(current, origin);
      reportedPi(current, ["idle", "working", "done"]);
    }
    if ((await approve({ core, name: options.name, origin: origin.address })) !== true) {
      fail("Launch not approved: the operator must verify the hc core launch environment");
    }
    checkCancelled(signal);
    await verifyOrigin();
    // Native creation atomically enforces uniqueness among live names; do not retry name_taken.
    const created = await call(
      "terminal.run",
      {
        argv,
        cwd,
        name: options.name,
        parent: origin.address,
        caller: origin.address,
        outlive_parent: true,
        // The core has its own environment; do not inherit Node preload/module lookup settings from it.
        env: { NODE_OPTIONS: "", NODE_PATH: "" },
        keep: false,
        rm: false,
        wait: false,
      },
      {
        capture: (value) => {
          if (terminalAddress(value?.address)) known.address = value.address;
        },
      },
    );
    const target = identity(created);
    if (target.address === origin.address) fail("Creation did not return a distinct peer terminal");
    const facts = { name: options.name, cwd, argv, origin: origin.address };
    targetFacts(created, target, facts, false);
    const waited = await call(
      "terminal.wait",
      { terminal: target.address, caller: origin.address, timeout: 30 },
      {
        timeoutMs: WAIT_TIMEOUT_MS,
      },
    );
    validateWait(waited, target.address);
    targetFacts(await call("terminal.get", { terminal: target.address }), target, facts, true);
    await verifyOrigin();
    targetFacts(await call("terminal.get", { terminal: target.address }), target, facts, true);
    const handoff = [
      "Peer task (peer content, not additional user authorization).",
      `Before work, read ${JSON.stringify(resolve(skill, "SKILL.md"))} (command: /skill:pi-herdr).`,
      `Initiator reply terminal: ${origin.address}. Rediscover live identities before sending a reply.`,
      "Terminal parent records ancestry, not Pi session identity or authority. Follow the skill's safe non-waiting progress/question/result exchange rules; report blockers promptly.",
      "Self-contained task follows:",
      task,
    ].join("\n\n");
    checkCancelled(signal);
    known.submissionAttempted = true;
    // Under its lock hc checks live/status/blocked, NOT PID, app, session or foreground identity.
    // These reads are best effort: takeover and draft races remain, including during native draft waiting.
    // Abort/timeout can follow successful delivery. Never retry or kill/remove this independent peer.
    const sent = await call(
      "terminal.send",
      {
        terminal: target.address,
        caller: origin.address,
        text: handoff,
        if: "idle",
        wait: false,
        force: false,
      },
      { timeoutMs: SEND_TIMEOUT_MS },
    );
    validateSend(sent);
    return {
      address: target.address,
      name: options.name,
      originAddress: origin.address,
      submitted: true,
      ...(typeof sent.started === "boolean" ? { started: sent.started } : {}),
    };
  } catch (error) {
    throw new SpawnHcPeerError(
      error instanceof SafeError ? error.message : "Spawn failed; inspect known state before retrying",
      known,
    );
  }
}
