import { consentFingerprint, participantBinding, requireHandover, revokeSyncModeGrants } from "./consent.js";
import { documentFingerprint } from "./document.js";
import { readIgnoreSource } from "./engine/ignore/ignore-source.js";
import { configFromSettings, loadConfigForCheck, syncSettingsConfigFingerprint } from "./engine/settings/config.js";
import {
  type LocalConfigDocument,
  localConfigPath,
  peekLocalConfigDocument,
  updateLocalConfigDocument,
} from "./engine/settings/config-file.js";
import { validateSettingsDocument } from "./engine/settings/settings-validation.js";
import { customAutomationSummary, syncMode, syncModeFlags } from "./engine/settings/sync-mode.js";
import { safeTerminalText } from "./engine/ui/terminal-text.js";
import { type Execution, record } from "./protocol.js";

function fingerprint(document: LocalConfigDocument | undefined) {
  return documentFingerprint(document && { bytes: document.bytes.toString("base64"), identity: document.identity });
}

export async function saveSyncMode(
  execution: Execution,
  payload: unknown,
  ignoreAvailable: boolean,
  committed: (mixed: boolean) => void,
) {
  const facts = execution.facts();
  if (
    !facts?.hasUI ||
    facts.mode !== "tui" ||
    !record(payload) ||
    (payload.mode !== "Manual" && payload.mode !== "Automatic") ||
    typeof payload.expected !== "string"
  )
    throw new Error("Changing the sync mode requires an interactive TUI review.");
  const original = await peekLocalConfigDocument();
  execution.validate();
  if (!original) throw new Error("No sync setup is configured.");
  const settings = validateSettingsDocument(original.parsed);
  const config = configFromSettings(settings);
  const setupName = config.setupName;
  const mode = payload.mode;
  const mixed = config.reservedIgnoreNames !== undefined;
  if (syncSettingsConfigFingerprint(config) !== payload.expected)
    throw new Error("Sync setup changed; reopen Settings before changing the mode.");
  if (mixed && !ignoreAvailable) throw new Error("Use a compatible Sync Daemon to change this setup's mode.");
  if (syncMode(config) === mode) return { kind: "unchanged" } as const;
  if (original.path !== localConfigPath())
    throw new Error("Changing the sync mode requires the canonical pi-sync.json. Migrate settings first.");
  const expectedDocument = fingerprint(original);
  const participants = participantBinding(execution);
  const binding = JSON.stringify(facts);
  const validate = () => {
    execution.validate();
    if (participants !== participantBinding(execution) || binding !== JSON.stringify(execution.facts()))
      throw new Error("Sync participants or the selected model changed; reopen the mode review.");
  };
  const validateSource = (document: LocalConfigDocument | undefined) => {
    validate();
    if (document?.path !== original.path || fingerprint(document) !== expectedDocument)
      throw new Error("Sync settings changed; reopen the mode review.");
  };
  const reviewed = mode === "Automatic" ? await loadConfigForCheck(undefined, execution.signal) : config;
  validateSource(await peekLocalConfigDocument());
  if (syncSettingsConfigFingerprint(reviewed) !== payload.expected) throw new Error("Sync policy changed.");
  const { ignorePolicy } = reviewed;
  const validateRules = async () => {
    if (ignorePolicy) {
      const source = await readIgnoreSource(execution.root, ignorePolicy.filename, execution.signal);
      if (
        !source.present ||
        source.sourceDigest !== ignorePolicy.sourceDigest ||
        source.identity !== reviewed.ignoreSourceIdentity
      )
        throw new Error("Sync ignore rules changed; reopen the mode review.");
    }
    validate();
  };
  const safePaths = (paths?: readonly string[]) => paths?.map(safeTerminalText).join(", ") || "none";
  const destination = reviewed.backend.destination;
  const lines = [
    `Setup: ${safeTerminalText(setupName)}`,
    `Storage: ${safeTerminalText(reviewed.connectionName)} · ${safeTerminalText(reviewed.storagePath)}`,
    ...("bucket" in destination ? [`Bucket: ${safeTerminalText(destination.bucket)}`] : []),
    ...("branch" in destination ? [`Branch: ${safeTerminalText(destination.branch)}`] : []),
    ...(syncMode(config) === "Custom" ? [`Replaces custom settings: ${customAutomationSummary(config)}.`] : []),
    ...(mode === "Manual"
      ? ["Stop new automatic transfers and model requests. Committed work is not undone."]
      : [
          ...(ignorePolicy
            ? [`Scope: eligible files under ${safeTerminalText(ignorePolicy.filename)}; review the local rules.`]
            : reviewed.scope === "agent-directory"
              ? [
                  "Scope: eligible files in the Pi agent directory.",
                  `Excluded: ${safePaths(reviewed.exclude)}. Re-included: ${safePaths(reviewed.reinclude)}.`,
                ]
              : [`Included paths: ${safePaths(reviewed.include)}`]),
          `Sessions: ${reviewed.include.includes("sessions") ? "opted in (path rules still apply)" : "Off"}.`,
          `Selected model: ${safeTerminalText(facts.model ? `${facts.model.provider}/${facts.model.id}` : "unavailable")}.`,
          "The daemon syncs when eligible and idle. It can replace or delete selected local and remote files without another transfer confirmation.",
          "Supported conflicts may be sent to the selected model's provider and incur charges. Unsupported conflicts retain their existing review and partial-progress rules.",
          "Selected-file watches, checks every 60–66 seconds and retries may incur storage costs. Local changes and temporary failures can cause requests between checks.",
          "Automatic model requests are limited to two per candidate and two per replica binding in a rolling 15-minute window, not by cost. Pi does not reload resources automatically.",
          "Upgrade all Pi processes sharing this agent directory. A missing baseline or a mismatched remote policy still requires review.",
        ]),
    "No transfer starts here. Work after the last Pi exits requires separate permission.",
  ];
  const accepted = await execution.request("merge-review", {
    title: `Use ${mode} sync?`,
    content: lines.join("\n\n"),
    confirmationLabel: `Use ${mode}`,
    summaryLines: lines,
  });
  validate();
  if (accepted !== true) return { kind: "cancelled" } as const;
  await requireHandover(execution);
  validate();
  const flags = syncModeFlags(mode);
  const next = {
    ...settings,
    syncSetups: {
      ...settings.syncSetups,
      [setupName]: {
        ...settings.syncSetups[setupName],
        sync: { ...settings.syncSetups[setupName].sync, ...flags },
      },
    },
  };
  await updateLocalConfigDocument(
    settings,
    () => next,
    validateSettingsDocument,
    execution.signal,
    validateSource,
    async () => {
      await validateRules();
      revokeSyncModeGrants(execution.root, setupName);
    },
  );
  committed(mixed);
  if (mode === "Automatic" && mixed) {
    try {
      const saved = await loadConfigForCheck(undefined, execution.signal);
      await validateRules();
      await saved.validateIgnorePolicy?.();
      validate();
      if (
        syncSettingsConfigFingerprint(saved) === syncSettingsConfigFingerprint(configFromSettings(next)) &&
        saved.ignoreSourceIdentity === reviewed.ignoreSourceIdentity &&
        saved.ignorePolicy?.sourceDigest === ignorePolicy?.sourceDigest
      )
        return { kind: "saved", reviewRequired: true, fingerprint: consentFingerprint(execution.root, saved) } as const;
    } catch {
      return { kind: "saved", reviewRequired: true } as const;
    }
    return { kind: "saved", reviewRequired: true } as const;
  }
  return { kind: "saved", reviewRequired: false } as const;
}
