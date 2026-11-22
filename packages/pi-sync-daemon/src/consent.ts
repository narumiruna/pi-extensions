import { createHash, createHmac, randomBytes } from "node:crypto";
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
import { startupTransferEnabled } from "./engine/sync/agent-policy.js";
import { syncSessionsSelected } from "./engine/sync/sync-policy.js";
import { safeTerminalText } from "./engine/ui/terminal-text.js";
import { type ClientFacts, type Execution, record } from "./protocol.js";

interface Consent {
  version: 1;
  root: string;
  handover: true;
  nonce: string;
  setups: Record<
    string,
    {
      fingerprint: string;
      automaticFingerprint?: string;
      model?: ClientFacts["model"];
      sessionDir?: string;
      cwd?: string;
      afterExit: boolean;
    }
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

export function revokeAfterExitGrants(root: string) {
  return revokeRetainedGrants(root);
}

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

export function revokeSyncModeGrants(root: string, setup: string) {
  const consent = readConsent(root);
  if (!consent) throw new Error("Review daemon handover first.");
  const saved = Object.hasOwn(consent.setups, setup) ? consent.setups[setup] : undefined;
  if (!saved || (!saved.afterExit && !saved.automaticFingerprint)) {
    try {
      syncConsentDirectory(file(root));
    } catch (error) {
      throw new ConsentPublicationError("Daemon consent revocation could not be verified.", { cause: error });
    }
    return;
  }
  saved.afterExit = false;
  delete saved.automaticFingerprint;
  publishConsent(consent);
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
        (entry.automaticFingerprint !== undefined &&
          (typeof entry.automaticFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.automaticFingerprint))) ||
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
function connectedReviewMarker(root: string, setup: string) {
  const key = createHash("sha256").update(setup).digest("hex");
  return path.join(path.dirname(file(root)), `daemon-connected-${key}.pending`);
}

function pendingConnectedReview(marker: string) {
  try {
    return lstatSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function retainConnectedReview(marker: string) {
  const pending = pendingConnectedReview(marker);
  if (!pending) {
    const fd = openSync(marker, "wx", 0o600);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else if (!pending.isFile() || pending.nlink !== 1 || pending.size !== 0) {
    throw new Error("Automatic approval has unsafe pending evidence; preserve it and repair the daemon state.");
  }
  syncConsentDirectory(marker);
}

function publishConnectedConsent(value: Consent, setup: string) {
  const marker = connectedReviewMarker(value.root, setup);
  retainConnectedReview(marker);
  publishConsent(value);
  rmSync(marker);
  try {
    syncConsentDirectory(marker);
  } catch (error) {
    retainConnectedReview(marker);
    throw new ConsentPublicationError("Automatic approval publication is uncertain; review the current policy again.", {
      cause: error,
    });
  }
}

export function automaticPolicyAuthorized(root: string, config: AnySyncConfig) {
  if (config.reservedIgnoreNames === undefined) return true;
  if (pendingConnectedReview(connectedReviewMarker(root, config.setupName))) return false;
  const saved = readConsent(root)?.setups[config.setupName];
  return saved?.automaticFingerprint !== undefined && saved.automaticFingerprint === consentFingerprint(root, config);
}

export async function reviewAutomaticPolicy(
  execution: Execution,
  config: AnySyncConfig,
  expectedFingerprint: string,
  needsFreshReview = false,
) {
  if (consentFingerprint(execution.root, config) !== expectedFingerprint)
    throw new Error("Setup changed; reopen the automatic transfer review.");
  if (config.reservedIgnoreNames === undefined) return false;
  const approvedBefore = automaticPolicyAuthorized(execution.root, config);
  if (approvedBefore && !needsFreshReview) return false;
  const consent = readConsent(execution.root);
  if (!consent) return false;
  const consentToken = JSON.stringify(consent);
  const peers = participantBinding(execution);
  const binding = JSON.stringify(execution.facts());
  const { loadConfigForCheck } = await import("./engine/settings/config.js");
  const fingerprint = syncCheckConfigFingerprint(config);
  const validate = () => {
    execution.validate();
    execution.signal.throwIfAborted();
    if (
      participantBinding(execution) !== peers ||
      JSON.stringify(execution.facts()) !== binding ||
      JSON.stringify(readConsent(execution.root)) !== consentToken
    )
      throw new Error("Participants or consent changed during automatic transfer review.");
  };
  const current = await loadConfigForCheck(undefined, execution.signal);
  validate();
  if (syncCheckConfigFingerprint(current) !== fingerprint) return false;
  const continuous = config.continuous && config.agentMode;
  const modes = [
    !continuous && startupTransferEnabled(config) && "Automatic transfer at startup",
    config.automatic &&
      syncSessionsSelected(config) &&
      "Push selected files on shutdown (including sessions when selected)",
    continuous && "Continuous sync (including the initial check) and Autonomous model requests",
  ].filter(Boolean);
  if (modes.length === 0) throw new Error("No automatic transfer mode is enabled under the current local rules.");
  if (approvedBefore) retainConnectedReview(connectedReviewMarker(execution.root, config.setupName));
  const title = "Allow the enabled automatic sync modes for this setup?";
  const destination = config.backend.destination;
  const lines = [
    `Setup: ${safeTerminalText(config.setupName)}`,
    `Destination: ${safeTerminalText(config.connectionName)} · ${safeTerminalText(config.storagePath)}`,
    ...("bucket" in destination ? [`Bucket: ${safeTerminalText(destination.bucket)}`] : []),
    ...("branch" in destination ? [`Branch: ${safeTerminalText(destination.branch)}`] : []),
    ...(config.ignorePolicy
      ? [
          `Local ignore file: ${safeTerminalText(config.ignorePolicy.filename)}`,
          "Review this file before you approve its scope.",
        ]
      : config.scope === "agent-directory"
        ? [
            "Scope: eligible files in the Pi agent directory.",
            `Excluded: ${config.exclude?.map(safeTerminalText).join(", ") || "none"}.`,
            `Re-included: ${config.reinclude?.map(safeTerminalText).join(", ") || "none"}.`,
          ]
        : [`Included paths: ${config.include.map(safeTerminalText).join(", ") || "none"}.`]),
    `Sessions: ${config.include.includes("sessions") ? "opted in (path rules still apply)" : "Off"}.`,
    `Enabled modes: ${modes.join("; ")}`,
    ...(config.agentMode
      ? [
          `Selected model: ${safeTerminalText(execution.facts()?.model?.provider ?? "unavailable")}/${safeTerminalText(execution.facts()?.model?.id ?? "unavailable")}.`,
          "Supported conflicts may be sent to the selected model's provider and incur charges.",
        ]
      : []),
    "The daemon may replace or delete selected local and remote files. Baseline, remote selection, and ownership checks still apply. This does not allow work after the last Pi exits. A settings or rule-file change requires a new review.",
  ];
  const accepted = await (execution.facts()?.mode === "tui"
    ? execution.request("merge-review", {
        title,
        content: lines.join("\n\n"),
        confirmationLabel: "Allow automatic transfers",
        summaryLines: lines,
      })
    : execution.request("confirm", { title, message: lines.join("\n") }));
  validate();
  if (accepted !== true) return false;
  const latest = await loadConfigForCheck(undefined, execution.signal);
  await config.validateIgnorePolicy?.();
  validate();
  if (syncCheckConfigFingerprint(latest) !== fingerprint)
    throw new Error("Setup changed during automatic transfer review.");
  const saved = consent.setups[config.setupName];
  const automaticFingerprint = consentFingerprint(execution.root, config);
  publishConnectedConsent(
    {
      ...consent,
      setups: {
        ...consent.setups,
        [config.setupName]: {
          ...saved,
          fingerprint: saved?.fingerprint ?? automaticFingerprint,
          afterExit: false,
          automaticFingerprint,
        },
      },
    },
    config.setupName,
  );
  return true;
}

export async function captureAutomaticAuthorization(
  execution: Execution,
  expectedFingerprint?: string,
  requiresReview?: (config: AnySyncConfig) => boolean,
) {
  const consent = readConsent(execution.root);
  if (!consent) throw new Error("Automatic work requires reviewed daemon handover first.");
  const consentToken = JSON.stringify(consent);
  const peers = participantBinding(execution);
  const { loadConfigForCheck } = await import("./engine/settings/config.js");
  const validateParticipants = () => {
    execution.validate();
    if (participantBinding(execution) !== peers || JSON.stringify(readConsent(execution.root)) !== consentToken)
      throw new Error("Daemon participants or consent changed before automatic work completed.");
  };
  validateParticipants();
  const config = await loadConfigForCheck(undefined, execution.signal);
  validateParticipants();
  const fingerprint = syncCheckConfigFingerprint(config);
  if (
    expectedFingerprint !== undefined ? fingerprint !== expectedFingerprint : config.reservedIgnoreNames !== undefined
  )
    throw new Error("Settings changed before automatic work; use the reviewed foreground command.");
  if (requiresReview?.(config) || !automaticPolicyAuthorized(execution.root, config))
    throw new Error(
      "Automatic transfer requires separate approval for the current setup and policy. Run reviewed /sync first.",
    );
  const validate = (current?: AnySyncConfig) => {
    validateParticipants();
    if (current && (syncCheckConfigFingerprint(current) !== fingerprint || requiresReview?.(current)))
      throw new Error("Settings changed or require review before automatic work completed.");
    if (!automaticPolicyAuthorized(execution.root, current ?? config))
      throw new Error("Automatic approval changed before work completed.");
  };
  const refresh = async () => {
    validate();
    validate(await loadConfigForCheck(undefined, execution.signal));
  };
  return { config, validate, refresh };
}

export function participantBinding(execution: Pick<Execution, "participants">) {
  return JSON.stringify(execution.participants().toSorted((left, right) => left.id.localeCompare(right.id)));
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
  const peers = participantBinding(execution);
  const { loadConfigForCheck } = await import("./engine/settings/config.js");
  const config = await loadConfigForCheck(undefined, execution.signal);
  execution.validate();
  if (participantBinding(execution) !== peers) throw new Error("Participants changed during daemon authorization.");
  const facts = execution.facts();
  const binding = JSON.stringify({ model: facts?.model, sessionDir: facts?.sessionDir, cwd: facts?.cwd });
  const fingerprint = consentFingerprint(execution.root, config);
  const policyGeneration = JSON.stringify(readConsent(execution.root));
  if (fingerprint !== payload.fingerprint) throw new Error("Setup changed; reopen the daemon authorization review.");
  if (payload.afterExit && (!config.continuous || !config.agentMode))
    throw new Error("Enable the reviewed Autonomous and Continuous policies first.");
  const paths = (rules?: readonly string[]) => rules?.map(safeTerminalText).join(", ") || "none";
  const selection = config.ignorePolicy
    ? [
        "Selected content: eligible files in the Pi agent directory",
        `Local ignore file: ${safeTerminalText(config.ignorePolicy.filename)}`,
        `Session opt-in: ${config.ignorePolicy.sessions ? "On — ignore rules still apply" : "Off"}`,
      ].join("\n")
    : config.scope === "agent-directory"
      ? [
          "Selected content: all eligible files in the Pi agent directory",
          `Excluded paths: ${paths(config.exclude)}`,
          `Re-included paths: ${paths(config.reinclude)}`,
          `Session opt-in: ${config.include.includes("sessions") ? "On — path rules still apply" : "Off"}`,
        ].join("\n")
      : `Selected content: ${paths(config.include)}`;
  const accepted = await execution.request("confirm", {
    title: payload.afterExit ? "Allow continuous sync after all Pi clients exit?" : "Revoke unattended sync?",
    message: `Setup: ${safeTerminalText(config.setupName)}\n${selection}\nModel: ${safeTerminalText(facts?.model?.provider ?? "unavailable")}/${safeTerminalText(facts?.model?.id ?? "unavailable")}\n\n${payload.afterExit ? `The daemon may transfer selected private content and send conflict evidence to this independently available provider after Pi exits. Existing budgets, exclusions, journals, and stale-evidence checks still apply. No parent conversation or tools are sent. Changing this setup or model invalidates this permission.${config.reservedIgnoreNames !== undefined ? " This also approves the enabled automatic modes for this setup while Pi clients are attached." : ""}` : "The daemon may remain alive, but no new transfer or model request may start with zero clients."}`,
  });
  execution.validate();
  if (accepted !== true) return undefined;
  const latest = await loadConfigForCheck(undefined, execution.signal);
  execution.validate();
  await config.validateIgnorePolicy?.();
  execution.validate();
  if (
    participantBinding(execution) !== peers ||
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
  const alsoApproveConnected = payload.afterExit && config.reservedIgnoreNames !== undefined;
  const next = {
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
        ...(alsoApproveConnected ? { automaticFingerprint: fingerprint } : {}),
      },
    },
  } satisfies Consent;
  if (alsoApproveConnected) publishConnectedConsent(next, config.setupName);
  else publishConsent(next);
  return { config, afterExit: payload.afterExit };
}
