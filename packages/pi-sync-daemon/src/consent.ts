import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { syncCheckConfigFingerprint } from "./engine/settings/config.js";
import type { AnySyncConfig } from "./engine/settings/settings-types.js";
import { stateDir } from "./engine/state/state-directory.js";
import { type ClientFacts, type Execution, record } from "./protocol.js";

interface Consent {
  version: 1;
  root: string;
  handover: true;
  nonce: string;
  setups: Record<
    string,
    { fingerprint: string; model?: ClientFacts["model"]; sessionDir?: string; cwd?: string; afterExit: boolean }
  >;
}
function file(root: string) {
  return path.join(stateDir(root), "daemon.json");
}
export class ConsentPublicationError extends Error {}
const FORMATTED_CONSENT_BYTES = 65_536;
// Each legacy grant already uses at least 64 bytes for its fingerprint. Reserving one byte per
// grant covers all legacy writes, including compact files, when `true` becomes `false`.
const MAX_CONSENT_BYTES = FORMATTED_CONSENT_BYTES + FORMATTED_CONSENT_BYTES / 64;

function compactConsentWithRevocationReserve(value: Consent) {
  const compact = JSON.stringify(value);
  const grantCount = Object.values(value.setups).filter((setup) => setup.afterExit).length;
  if (Buffer.byteLength(compact) + grantCount > MAX_CONSENT_BYTES)
    throw new Error("Daemon consent exceeds its storage bound; existing evidence retained.");
  return compact;
}

function syncConsentDirectory(target: string) {
  if (process.platform === "win32") return;
  const directory = openSync(path.dirname(target), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** A small synchronous publication keeps approval, metadata revocation, and rename in one event-loop turn. */
function publishConsent(value: Consent) {
  try {
    const target = file(value.root);
    const compact = compactConsentWithRevocationReserve(value);
    const formatted = `${JSON.stringify(value, null, "\t")}\n`;
    const content = Buffer.byteLength(formatted) <= FORMATTED_CONSENT_BYTES ? formatted : compact;
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
    const handle = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(handle, content);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporary, target);
      syncConsentDirectory(target);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    throw new ConsentPublicationError("Daemon consent publication failed; preserve the retained document.", {
      cause: error,
    });
  }
}

/** A different interactive binding cannot silently resume an older unattended grant after exit/restart. */
export function revokeChangedBindings(root: string, peers: readonly ClientFacts[]) {
  const consent = readConsent(root);
  if (!consent) return;
  const interactive = peers.filter((peer) => peer.hasUI);
  let changed = false;
  for (const saved of Object.values(consent.setups)) {
    if (
      saved.afterExit &&
      interactive.some(
        (peer) =>
          JSON.stringify(peer.model) !== JSON.stringify(saved.model) ||
          peer.sessionDir !== saved.sessionDir ||
          peer.cwd !== saved.cwd,
      )
    ) {
      saved.afterExit = false;
      changed = true;
    }
  }
  if (changed) publishConsent(consent);
}

/** Explicit offline repair only. The caller must exclude daemon owners and state migration. */
export function revokeRetainedGrants(root: string) {
  const consent = readConsent(root);
  if (!consent) return 0;
  let revoked = 0;
  for (const saved of Object.values(consent.setups)) {
    if (!saved.afterExit) continue;
    saved.afterExit = false;
    revoked += 1;
  }
  if (revoked) publishConsent(consent);
  // A prior attempt may have renamed the synced file but failed to sync the directory.
  else syncConsentDirectory(file(root));
  return revoked;
}

export function readConsent(root: string): Consent | undefined {
  const target = file(root);
  let handle: number | undefined;
  try {
    const before = lstatSync(target);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_CONSENT_BYTES ||
      (process.getuid && before.uid !== process.getuid()) ||
      (process.platform !== "win32" && before.mode & 0o077)
    )
      throw new Error("Unsafe daemon consent document; evidence retained.");
    handle = openSync(target, "r");
    const opened = fstatSync(handle);
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Daemon consent changed while opening.");
    const value: unknown = JSON.parse(readFileSync(handle, "utf8"));
    if (
      !record(value) ||
      value.version !== 1 ||
      value.root !== root ||
      value.handover !== true ||
      typeof value.nonce !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.nonce) ||
      !record(value.setups)
    )
      throw new Error("Invalid daemon consent; evidence retained.");
    for (const entry of Object.values(value.setups)) {
      if (
        !record(entry) ||
        typeof entry.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.fingerprint) ||
        typeof entry.afterExit !== "boolean" ||
        (entry.cwd !== undefined &&
          (typeof entry.cwd !== "string" || !path.isAbsolute(entry.cwd) || entry.cwd.includes("\0"))) ||
        (entry.sessionDir !== undefined &&
          (typeof entry.sessionDir !== "string" || !path.isAbsolute(entry.sessionDir))) ||
        (entry.model !== undefined &&
          (!record(entry.model) ||
            typeof entry.model.provider !== "string" ||
            typeof entry.model.id !== "string" ||
            typeof entry.model.signature !== "string" ||
            !/^[a-f0-9]{64}$/u.test(entry.model.signature) ||
            !["stored", "environment", "models_json_key", "models_json_command"].includes(
              String(entry.model.authSource),
            )))
      )
        throw new Error("Invalid daemon setup consent.");
    }
    const consent = value as unknown as Consent;
    compactConsentWithRevocationReserve(consent);
    return consent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
export function consentFingerprint(root: string, config: AnySyncConfig) {
  const consent = readConsent(root);
  if (!consent) throw new Error("Review daemon handover first.");
  // Keep the original digest domain across package renames; never persist the internal freshness token.
  return createHmac("sha256", consent.nonce)
    .update("sync-daemon-consent/v1")
    .update(syncCheckConfigFingerprint(config))
    .digest("hex");
}
export async function requireHandover(execution: Execution) {
  if (readConsent(execution.root)) return;
  const accepted = await execution.request("confirm", {
    title: "Adopt pi-sync-daemon as the synchronization owner?",
    message:
      "Close or upgrade every older Pi process before continuing. An idle older Pi cannot be detected from an absent sync lock. The daemon will own transfers; Pi keeps presentation and live file queues. Autonomous resolution uses independently available auth.json/models.json configuration and the environment captured when the service starts, not Pi runtime accounts or providers. Credential commands run non-interactively from the canonical agent root. Review this independent provider/account configuration; restart the service after changing its environment. This does not authorize transfers or model requests after the last Pi exits.",
  });
  execution.validate();
  if (accepted !== true) throw new Error("Daemon handover was not approved; no transfer was started.");
  const { withLock } = await import("./engine/state/lock.js");
  await withLock("daemon-handover", async () => {
    execution.validate();
    if (!readConsent(execution.root))
      publishConsent({
        version: 1,
        root: execution.root,
        handover: true,
        nonce: randomBytes(32).toString("hex"),
        setups: {},
      } satisfies Consent);
  });
}
export async function authorizeAfterExit(execution: Execution, payload: unknown) {
  if (!record(payload) || typeof payload.afterExit !== "boolean" || typeof payload.fingerprint !== "string")
    throw new Error("Invalid daemon authorization.");
  await requireHandover(execution);
  const { loadConfig } = await import("./engine/settings/config.js");
  const config = await loadConfig();
  const facts = execution.facts();
  const binding = JSON.stringify({ model: facts?.model, sessionDir: facts?.sessionDir, cwd: facts?.cwd });
  const fingerprint = consentFingerprint(execution.root, config);
  const policyGeneration = JSON.stringify(readConsent(execution.root));
  if (fingerprint !== payload.fingerprint) throw new Error("Setup changed; reopen the daemon authorization review.");
  if (payload.afterExit && (!config.continuous || !config.agentMode))
    throw new Error("Enable the reviewed Autonomous and Continuous policies first.");
  const accepted = await execution.request("confirm", {
    title: payload.afterExit ? "Allow continuous sync after all Pi clients exit?" : "Revoke unattended sync?",
    message: `Setup: ${config.setupName}\nSelected content: ${config.include.join(", ")}\nModel: ${facts?.model?.provider ?? "unavailable"}/${facts?.model?.id ?? "unavailable"}\n\n${payload.afterExit ? "The daemon may transfer selected private content and send conflict evidence to this independently available provider after Pi exits. Existing budgets, exclusions, journals, and stale-evidence checks still apply. No parent conversation or tools are sent. Changing this setup or model invalidates this permission." : "The daemon may remain alive, but no new transfer or model request may start with zero clients."}`,
  });
  execution.validate();
  if (accepted !== true) return false;
  const latest = await loadConfig();
  execution.validate();
  if (
    consentFingerprint(execution.root, latest) !== fingerprint ||
    JSON.stringify({
      model: execution.facts()?.model,
      sessionDir: execution.facts()?.sessionDir,
      cwd: execution.facts()?.cwd,
    }) !== binding
  )
    throw new Error("Setup or model changed during daemon authorization.");
  const consent = readConsent(execution.root);
  if (!consent || JSON.stringify(consent) !== policyGeneration)
    throw new Error("Daemon authorization changed; reopen its review.");
  publishConsent({
    ...consent,
    setups: {
      ...consent.setups,
      [config.setupName]: {
        ...consent.setups[config.setupName],
        fingerprint,
        model: facts?.model,
        sessionDir: facts?.sessionDir,
        cwd: facts?.cwd,
        afterExit: payload.afterExit,
      },
    },
  } satisfies Consent);
  return true;
}
