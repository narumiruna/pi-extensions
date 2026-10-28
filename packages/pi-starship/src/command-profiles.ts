import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { defineMenu, runLiveChoice, runMenu } from "@narumitw/pi-tui-kit";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { WorkflowOwner } from "./command-configuration.js";
import type { StarshipCommandOptions } from "./commands.js";
import { BUILT_IN_EXAMPLE, type LoadedStarshipConfig, validateConfigDocument } from "./config.js";
import {
  createProfile,
  deleteHistory,
  deleteProfile,
  duplicateProfile,
  type HistoryDocument,
  listHistory,
  listProfiles,
  type ProfileDocument,
  readHistory,
  readProfile,
  renameProfile,
  saveProfile,
} from "./profile-store.js";

export type ProfileApplyCandidate = (
  loaded: LoadedStarshipConfig,
  owner: WorkflowOwner,
  checkCandidate: () => void,
  name: string,
) => Promise<"applied" | "stay" | "close">;

type Document = ProfileDocument | HistoryDocument;
type Exit = "back" | "close";
interface Action {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}
interface Candidate {
  loaded?: LoadedStarshipConfig;
  lines: string[];
}

const PREVIEW_NOTICE = "Preview uses the current runtime snapshot only; unavailable module data can be empty.";
const SAVE_CURRENT = "save-current";
class FlowEnded extends Error {}

/** Profiles are independent copies. Only applyCandidate may replace active settings. */
export async function showProfiles(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
  applyCandidate: ProfileApplyCandidate,
): Promise<Exit> {
  return browseDocuments(ctx, options, owner, applyCandidate, "profile");
}

export async function showHistory(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
  applyCandidate: ProfileApplyCandidate,
): Promise<Exit> {
  return browseDocuments(ctx, options, owner, applyCandidate, "history");
}

/** Reusable by reviewed preset/Gist candidates; never writes the active file. */
export async function saveAsProfile(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
  raw: string,
): Promise<ProfileDocument | "close" | undefined> {
  if (!interactive(ctx) || !current(owner)) return undefined;
  const flow = createFlow(ctx, options, owner);
  try {
    candidateFor(options, raw, true);
    const saved = await saveNamedCopy(ctx, options, flow, raw);
    flow.ensure();
    return saved;
  } catch (error) {
    if (flow.signal.aborted || !flow.sessionCurrent()) return "close";
    report(ctx, flow, error);
    return undefined;
  } finally {
    flow.dispose();
  }
}

async function browseDocuments(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
  applyCandidate: ProfileApplyCandidate,
  kind: Document["kind"],
): Promise<Exit> {
  if (!interactive(ctx) || !current(owner)) return "close";
  const flow = createFlow(ctx, options, owner);
  let selectedId: string | undefined;
  try {
    while (flow.current()) {
      let interacted = false;
      try {
        const documents: Document[] =
          kind === "profile" ? listProfiles(options.settingsPath) : listHistory(options.settingsPath);
        const active = options.getLoaded();
        const matches = documents.filter(
          (document) => document.rawDocument !== undefined && document.rawDocument === active.rawDocument,
        );
        const candidates = new Map(
          documents.map((document) => [documentId(document), candidateFor(options, document.rawDocument)]),
        );
        const selection = await runLiveChoice(ctx, {
          title: kind === "profile" ? "Profiles" : "History",
          lines: [
            active.rawDocument === undefined && active.diagnostics.length === 0
              ? "Active: Built-in defaults"
              : active.diagnostics.some((item) => item.severity === "error")
                ? "Active: Invalid settings document · replacement requires explicit recovery"
                : "Active: Independent settings document",
            ...(kind === "profile" && matches.length === 0 ? ["Current settings are not saved as a profile"] : []),
            PREVIEW_NOTICE,
          ],
          items: [
            ...(kind === "profile"
              ? [
                  {
                    id: SAVE_CURRENT,
                    label: "Save current as…",
                    description: "Copy exact loaded TOML; keep active settings unchanged",
                  },
                ]
              : []),
            ...documents.map((document) => ({
              id: documentId(document),
              label: safe(document.name),
              description: [
                ...(document.kind === "history"
                  ? [safe(document.createdAt), ...(document.legacy ? ["Legacy · read-only"] : [])]
                  : []),
                ...(document.rawDocument !== undefined && document.rawDocument === active.rawDocument
                  ? ["Matches active settings"]
                  : []),
                ...(!candidates.get(documentId(document))?.loaded ? ["Invalid document · review or repair"] : []),
              ].join(" · "),
              details: [
                `Selected: ${safe(document.name)}`,
                `Path: ${safe(document.path)}`,
                ...(candidates.get(documentId(document))?.lines ?? []),
              ],
            })),
          ],
          initialItemId: selectedId,
          enableSearch: true,
          viewportSize: 10,
          hint: "back",
          confirmLabel: "actions",
          navigationLabel: "live preview",
          signal: flow.signal,
          isCurrent: flow.current,
          onSelectionChange: ({ item, signal }) => {
            if (signal.aborted || !flow.current()) return;
            selectedId = item.id;
            flow.preview(candidates.get(item.id)?.loaded);
          },
        });
        flow.ensure();
        interacted = true;
        if (selection.kind !== "selected") {
          return selection.kind === "closed" && selection.reason === "back" ? "back" : "close";
        }
        selectedId = selection.itemId;
        if (selectedId === SAVE_CURRENT) {
          flow.preview(undefined);
          const loaded = options.getLoaded();
          if (loaded.diagnostics.some((item) => item.severity === "error")) {
            throw new Error(
              "Cannot save unreadable or malformed active settings as a profile. Repair the settings document first.",
            );
          }
          const raw = loaded.rawDocument ?? BUILT_IN_EXAMPLE;
          candidateFor(options, raw, true);
          const saved = await saveNamedCopy(ctx, options, flow, raw);
          flow.ensure();
          if (saved) selectedId = documentId(saved);
          continue;
        }
        const document = documents.find((item) => documentId(item) === selectedId);
        if (!document) continue;
        flow.ensure(document);
        const outcome = await documentActions(ctx, options, flow, document, applyCandidate);
        flow.ensure();
        if (outcome === "close") return "close";
        if (outcome) selectedId = documentId(outcome);
      } catch (error) {
        if (error instanceof FlowEnded || !flow.current()) return "close";
        flow.preview(undefined);
        report(ctx, flow, error);
        if (!interacted) return "close";
      }
    }
    return "close";
  } finally {
    flow.dispose();
  }
}

async function documentActions(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  flow: ReturnType<typeof createFlow>,
  document: Document,
  applyCandidate: ProfileApplyCandidate,
): Promise<Document | "close" | undefined> {
  const candidate = candidateFor(options, document.rawDocument);
  const profile = document.kind === "profile";
  const activeInvalid = profile && options.getLoaded().diagnostics.some((item) => item.severity === "error");
  const action = await actionScreen(ctx, flow, {
    kind: document.kind,
    title: `${profile ? "Profile" : "Recovery copy"}: ${safe(document.name)}`,
    lines: [
      `Path: ${safe(document.path)}`,
      ...(document.kind === "history"
        ? [`Recovery time: ${safe(document.createdAt)}`, "A recovery copy is not proof that an application succeeded."]
        : []),
      ...(document.kind === "history" && document.legacy
        ? ["Legacy backup · read-only; restore copies bytes without changing this backup."]
        : []),
      ...(document.readError ? [safe(document.readError)] : []),
      ...candidate.lines,
      PREVIEW_NOTICE,
    ],
    raw: document.rawDocument,
    actions: [
      {
        id: "apply",
        label: profile ? "Apply…" : "Restore…",
        disabled: !candidate.loaded || activeInvalid,
        disabledReason: activeInvalid
          ? "Repair active settings or use explicit recovery first"
          : "Invalid TOML cannot be applied",
      },
      ...(profile
        ? [
            { id: "edit", label: "Edit TOML…" },
            { id: "duplicate", label: "Duplicate…" },
            { id: "rename", label: "Rename…" },
          ]
        : [
            {
              id: "save-as",
              label: "Save as a profile…",
              disabled: !candidate.loaded,
              disabledReason: "Invalid TOML cannot be saved as a validated profile",
            },
          ]),
      {
        id: "delete",
        label: "Delete…",
        disabled: document.kind === "history" && document.legacy,
        disabledReason: "Legacy backups are read-only",
      },
    ],
  });
  flow.ensure(document);
  if (action === "close") return "close";
  if (action === "back") return undefined;
  if (action === "apply" && candidate.loaded) {
    const result = await applyReviewedCandidate(flow, candidate.loaded, applyCandidate, document);
    flow.ensure(document);
    return result === "close" ? "close" : document;
  }
  if (action === "edit" && profile) {
    const result = await editProfile(ctx, options, flow, document, applyCandidate);
    flow.ensure();
    return result;
  }
  if (action === "rename" && profile) {
    const name = await flow.dialog(() =>
      ctx.ui.input(`Rename profile: ${safe(document.name)}`, "New profile name", { signal: flow.signal }),
    );
    flow.ensure(document);
    if (name === undefined) return document;
    return renameProfile(options.settingsPath, document.name, name, document);
  }
  if (action === "duplicate" || (action === "save-as" && document.rawDocument !== undefined)) {
    const saved = await saveNamedCopy(ctx, options, flow, document.rawDocument, document);
    flow.ensure(document);
    return action === "duplicate" || document.kind === "history" ? document : (saved ?? document);
  }
  if (action === "delete" && !(document.kind === "history" && document.legacy)) {
    const confirmed = await flow.dialog(() =>
      ctx.ui.confirm(
        `Delete ${profile ? "profile" : "recovery copy"}: ${safe(document.name)}?`,
        `Path: ${safe(document.path)}\n${profile ? "This deletes only the saved profile. The active settings copy remains unchanged." : "This permanently deletes only this recovery copy. Active settings remain unchanged."}`,
        { signal: flow.signal },
      ),
    );
    flow.ensure(document);
    if (confirmed) {
      if (document.kind === "profile") deleteProfile(options.settingsPath, document.name, document);
      else deleteHistory(options.settingsPath, document.name, document);
    }
  }
  return undefined;
}

async function editProfile(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  flow: ReturnType<typeof createFlow>,
  original: ProfileDocument,
  applyCandidate: ProfileApplyCandidate,
): Promise<ProfileDocument | "close"> {
  let draft = original.rawDocument ?? "";
  if (original.rawDocument === undefined) {
    const repair = await flow.dialog(() =>
      ctx.ui.confirm(
        `Repair invalid UTF-8 profile: ${safe(original.name)}?`,
        `Path: ${safe(original.path)}\nThe original bytes cannot be edited as TOML text. Open an empty repair draft? Saving replaces these invalid bytes; the saved copy stays unchanged until you select Save profile. Duplicate it first to keep the original bytes.`,
        { signal: flow.signal },
      ),
    );
    flow.ensure(original);
    if (!repair) return original;
  }
  while (flow.current()) {
    // Pi's editor has no signal or public dismissal API. Drain it, then reject
    // stale completion. The owner abort listener clears the footer immediately.
    const edited = await flow.dialog(() => ctx.ui.editor(`Edit profile: ${safe(original.name)}`, draft));
    flow.ensure(original);
    if (edited === undefined) return original;
    draft = edited;
    const candidate = candidateFor(options, draft);
    flow.preview(candidate.loaded);
    const action = await actionScreen(ctx, flow, {
      title: candidate.loaded ? "Profile draft preview" : "Profile draft needs attention",
      lines: [
        "Save profile changes only the saved copy, even when it matches active settings.",
        ...candidate.lines,
        PREVIEW_NOTICE,
      ],
      raw: draft,
      actions: [
        {
          id: "save",
          label: "Save profile",
          disabled: !candidate.loaded,
          disabledReason: "Repair the draft before saving",
        },
        {
          id: "save-apply",
          label: "Save profile and apply…",
          description: "Two operations: a failed apply retains the saved profile",
          disabled: !candidate.loaded,
          disabledReason: "Repair the draft before saving",
        },
        { id: "continue", label: "Continue editing" },
        { id: "discard", label: "Discard draft" },
      ],
    });
    flow.ensure(original);
    if (action === "close") return "close";
    if (action === "discard") return original;
    if (action === "continue" || action === "back") continue;
    if (!candidate.loaded || (action !== "save" && action !== "save-apply")) continue;
    const saved = saveProfile(options.settingsPath, original.name, draft, original);
    ctx.ui.notify(`Profile saved: ${safe(saved.name)}. Active settings are unchanged.`, "info");
    if (action === "save-apply") {
      try {
        const result = await applyReviewedCandidate(flow, candidate.loaded, applyCandidate, saved);
        flow.ensure(saved);
        if (result === "close") return "close";
        if (result !== "applied")
          ctx.ui.notify(
            "The profile was saved. Application did not complete; review the configuration result before retrying.",
            "warning",
          );
      } catch (error) {
        if (!flow.current()) throw error;
        ctx.ui.notify(
          `The saved profile was retained, but application did not complete: ${safeError(error)}. Review active settings before retrying.`,
          "error",
        );
      }
    }
    return saved;
  }
  throw new FlowEnded();
}

async function applyReviewedCandidate(
  flow: ReturnType<typeof createFlow>,
  loaded: LoadedStarshipConfig,
  applyCandidate: ProfileApplyCandidate,
  document: Document,
) {
  flow.ensure(document);
  const result = await applyCandidate(
    loaded,
    {
      signal: flow.signal,
      // The shared commit policy captures the active revision before applying.
      // A successful apply changes it; session ownership must remain valid after it.
      isCurrent: () => !flow.signal.aborted && flow.sessionCurrent(),
      isSessionCurrent: flow.sessionCurrent,
    },
    () => flow.ensure(document),
    document.name,
  );
  // Only this operation may advance the loaded revision. Other awaits must keep
  // the reviewed active revision; failed or cancelled applies cannot adopt it.
  if (result === "applied") flow.adoptAppliedRevision();
  flow.ensure(document);
  flow.preview(undefined);
  return result;
}

async function saveNamedCopy(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  flow: ReturnType<typeof createFlow>,
  raw: string | undefined,
  source?: Document,
): Promise<ProfileDocument | undefined> {
  while (flow.current()) {
    const name = await flow.dialog(() =>
      ctx.ui.input("Save as a profile", "Profile name (without .toml)", { signal: flow.signal }),
    );
    flow.ensure(source);
    if (name === undefined) return undefined;
    try {
      const saved =
        source?.kind === "profile"
          ? duplicateProfile(options.settingsPath, source.name, name, source)
          : createProfile(options.settingsPath, name, requireText(raw));
      ctx.ui.notify(`Profile saved: ${safe(saved.name)}. Active settings are unchanged.`, "info");
      return saved;
    } catch (error) {
      report(ctx, flow, error);
    }
  }
  throw new FlowEnded();
}

async function actionScreen(
  ctx: ExtensionCommandContext,
  flow: ReturnType<typeof createFlow>,
  screen: { kind?: Document["kind"]; title: string; lines: string[]; actions: Action[]; raw: string | undefined },
): Promise<string> {
  let selected: string | undefined;
  const menu = defineMenu<undefined, "actions" | "document", "select">({
    start: "actions",
    screens: {
      actions: () => ({
        kind: "actions",
        title: screen.title,
        lines: screen.lines,
        items: [
          ...(screen.kind === "profile"
            ? screen.actions.slice(0, 1).map((action) => ({ ...action, action: "select" as const }))
            : []),
          {
            id: "review",
            label: "Review TOML",
            to: "document",
            disabled: screen.raw === undefined,
            disabledReason: "The document is not valid UTF-8",
          },
          ...(screen.kind === "profile" ? screen.actions.slice(1) : screen.actions).map((action) => ({
            ...action,
            action: "select" as const,
          })),
        ],
        hint: "back",
      }),
      document: () => ({
        kind: "review",
        title: screen.title,
        lines: ["Exact UTF-8 text · display controls sanitized · read-only"],
        content: screen.raw ?? "The document is not valid UTF-8; no decoded fallback is shown.",
        format: { kind: "code", language: "toml" },
        enableSearch: true,
        viewportSize: "adaptive",
        hint: "back",
      }),
    },
    actions: {
      select: ({ itemId }) => {
        flow.ensure();
        selected = itemId;
        return { kind: "close" };
      },
    },
  });
  const result = await runMenu(ctx, menu, { getState: () => undefined, signal: flow.signal, isCurrent: flow.current });
  flow.ensure();
  return selected ?? (result.kind === "closed" && result.reason === "back" ? "back" : "close");
}

function createFlow(ctx: ExtensionCommandContext, options: StarshipCommandOptions, owner: WorkflowOwner) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, owner.signal]);
  let revision = options.getLoadedRevision?.();
  let activeDocument = activeFingerprint(options.getLoaded());
  let previewOwned = false;
  const isCurrent = () =>
    !signal.aborted &&
    owner.isCurrent() &&
    (revision === undefined
      ? activeFingerprint(options.getLoaded()) === activeDocument
      : options.getLoadedRevision?.() === revision);
  const clearPreview = () => {
    if (!previewOwned) return;
    previewOwned = false;
    // The session owner, not a captured footer snapshot, decides whether cleanup
    // can touch the UI, even after command cancellation. Runtime lifecycle
    // cleanup owns a replaced session.
    if (owner.isSessionCurrent?.() ?? owner.isCurrent()) {
      try {
        options.preview?.(undefined, ctx);
      } catch (error) {
        ctx.ui.notify(`Could not clear the footer preview: ${safeError(error)}`, "error");
      }
    }
  };
  const matches = (expected?: Document) => {
    if (!isCurrent()) return false;
    if (!expected) return true;
    try {
      const fresh =
        expected.kind === "profile"
          ? readProfile(options.settingsPath, expected.name)
          : readHistory(options.settingsPath, expected.name);
      return (
        fresh.rawDocument === expected.rawDocument &&
        fresh.identity.dev === expected.identity.dev &&
        fresh.identity.ino === expected.identity.ino &&
        fresh.identity.size === expected.identity.size &&
        fresh.identity.mtimeNs === expected.identity.mtimeNs &&
        fresh.identity.ctimeNs === expected.identity.ctimeNs &&
        fresh.rawBytes.equals(expected.rawBytes)
      );
    } catch {
      return false;
    }
  };
  const ensure = (expected?: Document) => {
    if (!isCurrent()) throw new FlowEnded();
    if (!matches(expected))
      throw new Error("The selected document changed or was removed. Review the latest copy before trying again.");
  };
  signal.addEventListener("abort", clearPreview, { once: true });
  return {
    signal,
    current: isCurrent,
    sessionCurrent: () => owner.isSessionCurrent?.() ?? owner.isCurrent(),
    ensure,
    preview(loaded: LoadedStarshipConfig | undefined) {
      ensure();
      if (!loaded) {
        clearPreview();
        return;
      }
      previewOwned = true;
      try {
        options.preview?.(loaded, ctx);
      } catch (error) {
        clearPreview();
        throw error;
      }
    },
    async dialog<Value>(run: () => Promise<Value>): Promise<Value> {
      ensure();
      // Native dialogs collapse Escape and Ctrl+C into one result. Observe only
      // hard cancellation; never consume, rewrite, or forward editor content.
      const unsubscribe = ctx.ui.onTerminalInput((data) => {
        if (!isKeyRelease(data) && matchesKey(data, Key.ctrl("c"))) {
          // Abort after native input dispatch, before its promise continuation.
          // Synchronous abort could restore focus and leak this key to Pi's editor.
          queueMicrotask(() => controller.abort());
        }
        return undefined;
      });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unsubscribe();
      };
      signal.addEventListener("abort", release, { once: true });
      try {
        if (signal.aborted) release();
        ensure();
        const result = await run();
        ensure();
        return result;
      } finally {
        signal.removeEventListener("abort", release);
        release();
      }
    },
    adoptAppliedRevision() {
      if (signal.aborted || !(owner.isSessionCurrent?.() ?? owner.isCurrent())) throw new FlowEnded();
      revision = options.getLoadedRevision?.();
      activeDocument = activeFingerprint(options.getLoaded());
    },
    dispose() {
      try {
        clearPreview();
      } finally {
        signal.removeEventListener("abort", clearPreview);
        controller.abort();
      }
    },
  };
}

function candidateFor(options: StarshipCommandOptions, raw: string | undefined, required = false): Candidate {
  try {
    if (raw === undefined) throw new Error("The document is not valid UTF-8; no decoded fallback is shown.");
    const loaded = (options.validate ?? validateConfigDocument)(options.settingsPath, raw);
    if (loaded.diagnostics.some((item) => item.severity === "error"))
      throw new Error(loaded.diagnostics.map((item) => item.message).join("; "));
    return {
      loaded,
      lines:
        loaded.diagnostics.length === 0
          ? ["No configuration warnings."]
          : loaded.diagnostics.map((item) => `${safe(item.path || "root")}: ${safe(item.message)}`),
    };
  } catch (error) {
    if (required) throw error;
    return { lines: [`Invalid TOML: ${safeError(error)}`, "No candidate footer preview is shown."] };
  }
}

function requireText(raw: string | undefined): string {
  if (raw === undefined) throw new Error("The document is not valid UTF-8; no decoded fallback can be saved.");
  return raw;
}

function activeFingerprint(loaded: LoadedStarshipConfig) {
  return JSON.stringify([loaded.source, loaded.rawDocument, loaded.diagnostics]);
}

function current(owner: WorkflowOwner) {
  return !owner.signal.aborted && owner.isCurrent();
}

function interactive(ctx: ExtensionCommandContext) {
  if (ctx.mode === "tui" && ctx.hasUI) return true;
  if (ctx.hasUI) ctx.ui.notify("Profiles and History require TUI mode.", "info");
  return false;
}

function documentId(document: Document) {
  return `${document.kind}:${document.name}`;
}

function report(ctx: ExtensionCommandContext, flow: ReturnType<typeof createFlow>, error: unknown) {
  if (!(error instanceof FlowEnded) && flow.current()) ctx.ui.notify(safeError(error), "error");
}

function safeError(error: unknown) {
  return safe(error instanceof Error ? error.message : String(error));
}

function safe(value: string) {
  return sanitizeTerminalText(value);
}
