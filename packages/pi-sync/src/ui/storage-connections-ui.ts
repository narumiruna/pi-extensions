import { isDeepStrictEqual } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
  addStorageConnection,
  removeStorageConnection,
  updateStorageConnection,
} from "../settings/settings-management.js";
import { readLocalConfigObject } from "../settings/settings-store.js";
import { isCloudflareR2Endpoint, normalizeS3Endpoint, ownRecord } from "../settings/settings-validation.js";
import { syncErrorGuidance } from "../sync/sync-error-guidance.js";
import { showAddGitStorageProfile, showEditGitStorageProfile } from "./setup/git-ui.js";
import { applyS3CredentialUpdate, chooseS3Credentials, chooseS3CredentialUpdate } from "./setup/s3-credentials-ui.js";
import { promptResourceName } from "./setup/setup-prompts.js";
import { saveReviewedDraft } from "./setup/setup-review.js";
import { requiredInput, requiredValueInput } from "./setup/text-input.js";
import { showAddWebDavStorageProfile, showEditWebDavStorageProfile } from "./setup/webdav-ui.js";
import { safeTerminalText } from "./terminal-text.js";

export async function showStorageConnections(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  let selectedName: string | undefined;
  const nameById = new Map<string, string>();
  type Screen = "list" | "detail";
  type Action = "add" | "select" | "edit" | "remove" | "back";
  const menu = defineMenu<Awaited<ReturnType<typeof loadStorageMenuState>>, Screen, Action, ExtensionCommandContext>({
    start: "list",
    screens: {
      list: ({ state }) => {
        nameById.clear();
        const names = Object.keys(state.profiles).sort((left, right) => left.localeCompare(right));
        return {
          kind: "actions",
          title: "Storage connections",
          lines: state.version3
            ? ["Server addresses and sign-in details, reusable across sync setups."]
            : ["Create version 3 settings before managing storage connections."],
          items: state.version3
            ? [
                { id: "add", label: "Add storage connection", action: "add" as const },
                ...names.map((name, index) => {
                  const id = `connection:${index}`;
                  nameById.set(id, name);
                  return {
                    id,
                    label: safeTerminalText(name),
                    description: connectionSummary(ownRecord(state.profiles[name]) ?? {}),
                    action: "select" as const,
                  };
                }),
              ]
            : [],
          hint: "back",
        };
      },
      detail: ({ state }) => ({
        kind: "actions",
        title: state.selected ? `Storage connection “${safeTerminalText(state.selected.name)}”` : "Storage connection",
        lines: state.selected?.lines ?? ["This storage connection no longer exists."],
        items: state.selected
          ? [
              { id: "edit", label: "Edit storage connection…", action: "edit" },
              ...(state.selected.usedBy.length === 0
                ? [
                    {
                      id: "remove",
                      label: "Remove storage connection…",
                      action: "remove" as const,
                    },
                  ]
                : []),
              { id: "back", label: "Back", action: "back" },
            ]
          : [{ id: "back", label: "Back", action: "back" }],
        hint: "back",
      }),
    },
    actions: {
      add: async () => {
        try {
          await showAddStorageConnection(ctx, signal);
        } catch (error) {
          if (!signal?.aborted) {
            ctx.ui.notify(`Storage connection was not added: ${syncErrorGuidance(error)}`, "error");
          }
        }
        return { kind: "stay" };
      },
      select: async ({ itemId }) => {
        selectedName = nameById.get(itemId);
        return selectedName ? { kind: "to", screen: "detail" } : { kind: "rejected" };
      },
      edit: async ({ state }) => {
        if (!state.selected || state.selected.name !== selectedName) return { kind: "rejected" };
        try {
          await editStorageConnection(ctx, state.selected.name, state.selected.profile, state.selected.usedBy, signal);
        } catch (error) {
          notifyConnectionError(ctx, state.selected.name, error, signal);
        }
        return { kind: "stay" };
      },
      remove: async ({ state }) => {
        if (!state.selected || state.selected.name !== selectedName) return { kind: "rejected" };
        const name = state.selected.name;
        const confirmed = await ctx.ui.confirm(
          "Remove storage connection?",
          `Remove local storage connection “${safeTerminalText(name)}”? Remote data and history are not deleted.`,
          { signal },
        );
        if (!confirmed || signal?.aborted) return { kind: "rejected" };
        try {
          await removeStorageConnection(name, signal);
          ctx.ui.notify(`Removed storage connection “${safeTerminalText(name)}”.`, "info");
          selectedName = undefined;
          return { kind: "back" };
        } catch (error) {
          notifyConnectionError(ctx, name, error, signal);
          return { kind: "stay" };
        }
      },
      back: async () => {
        selectedName = undefined;
        return { kind: "back" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => loadStorageMenuState(selectedName, signal),
    signal,
    isCurrent: () => !signal?.aborted,
  });
}

async function loadStorageMenuState(selectedName: string | undefined, signal?: AbortSignal) {
  const raw = await readLocalConfigObject();
  if (signal?.aborted) throw signal.reason;
  const profiles = ownRecord(raw?.storageConnections) ?? {};
  const profile = selectedName ? ownRecord(profiles[selectedName]) : undefined;
  if (!selectedName || !profile) {
    return { version3: raw?.version === 3, profiles, selected: undefined };
  }
  const usedBy = referencingSetups(raw, selectedName);
  return {
    version3: raw?.version === 3,
    profiles,
    selected: {
      name: selectedName,
      profile,
      usedBy,
      lines: [
        `Type: ${connectionType(profile)}`,
        `Endpoint: ${connectionEndpoint(profile)}`,
        `Credentials: ${credentialSource(profile)}`,
        `Used by: ${usedBy.length > 0 ? usedBy.map(safeTerminalText).join(", ") : "No sync setups"}`,
        ...(usedBy.length > 0
          ? [
              "Remove unavailable: remove the listed sync setups first. Switch away from a current setup before removing it if other setups remain.",
            ]
          : []),
      ],
    },
  };
}

function notifyConnectionError(ctx: ExtensionCommandContext, name: string, error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return;
  ctx.ui.notify(`Storage connection “${safeTerminalText(name)}” was not changed: ${syncErrorGuidance(error)}`, "error");
}

async function editStorageConnection(
  ctx: ExtensionCommandContext,
  name: string,
  profile: Record<string, unknown>,
  usedBy: string[],
  signal?: AbortSignal,
) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "Editing storage connections requires TUI mode for safe credential handling. Edit the private version 3 settings file instead.",
      "warning",
    );
    return;
  }
  if (profile.type === "webdav") {
    await showEditWebDavStorageProfile(
      ctx,
      name,
      { ...profile, kind: "webdav", ...(ownRecord(profile.credentials) ?? {}) },
      signal,
      usedBy,
    );
    return;
  }
  if (profile.type === "git") {
    await showEditGitStorageProfile(ctx, name, { ...profile, kind: "git" }, signal, usedBy);
    return;
  }
  const endpoint = await requiredInput(
    ctx,
    "Endpoint",
    String(profile.endpoint ?? "https://s3.example.com"),
    signal,
    normalizeS3Endpoint,
  );
  if (!endpoint || signal?.aborted) return;
  const region = await requiredInput(
    ctx,
    "Region\n\nUse your bucket's region; Cloudflare R2 uses auto.",
    String(profile.region ?? "auto"),
    signal,
  );
  if (!region || signal?.aborted) return;
  const storedCredentials = ownRecord(profile.credentials) ?? {};
  const credentials = await chooseS3CredentialUpdate(ctx, { ...profile, ...storedCredentials }, signal);
  if (!credentials || signal?.aborted) return;
  const saved = await saveReviewedDraft(
    ctx,
    "Review storage connection",
    [
      `Storage connection: ${safeTerminalText(name)}`,
      `Endpoint: ${safeTerminalText(String(profile.endpoint ?? "missing"))} → ${safeTerminalText(endpoint)}`,
      `Region: ${safeTerminalText(String(profile.region ?? "auto"))} → ${safeTerminalText(region)}`,
      `Credentials: ${safeTerminalText(credentials.summary)}`,
      `Affected sync setups: ${usedBy.length > 0 ? usedBy.map(safeTerminalText).join(", ") : "None"}`,
      "Saving changes future storage access for every affected setup; it does not move remote data.",
    ],
    "Save storage connection",
    (saveSignal) =>
      updateStorageConnection(
        name,
        (current) => {
          if (current.type !== "s3" || !isDeepStrictEqual(current, profile)) {
            throw new Error("Storage connection changed while it was open; reopen it.");
          }
          return {
            ...current,
            endpoint,
            region,
            credentials: applyS3CredentialUpdate(current.credentials, credentials) as typeof current.credentials,
          };
        },
        usedBy,
        saveSignal,
      ),
    signal,
  );
  if (!saved || signal?.aborted) return;
  ctx.ui.notify(`Saved storage connection “${safeTerminalText(name)}”.`, "info");
}

export async function showAddStorageConnection(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "Adding storage connections requires TUI mode for safe credential handling. Edit the private version 3 settings file instead.",
      "warning",
    );
    return false;
  }
  const preset = await ctx.ui.select(
    "Storage type",
    ["Cloudflare R2", "Other S3-compatible storage", "WebDAV", "Git", "Cancel"],
    { signal },
  );
  if (signal?.aborted || !preset || preset === "Cancel") return false;
  if (preset === "WebDAV") return showAddWebDavStorageProfile(ctx, signal);
  if (preset === "Git") return showAddGitStorageProfile(ctx, signal);
  const name = await promptResourceName(ctx, "storage connection", preset === "Cloudflare R2" ? "r2" : "s3", signal);
  if (!name || signal?.aborted) return false;
  const endpoint = await requiredValueInput(
    ctx,
    "S3 API endpoint\n\nUse the API URL from your storage provider, not its web console.",
    preset === "Cloudflare R2" ? "https://<account-id>.r2.cloudflarestorage.com" : "https://s3.example.com",
    signal,
    normalizeS3Endpoint,
  );
  if (!endpoint || signal?.aborted) return false;
  const region =
    preset === "Cloudflare R2"
      ? "auto"
      : await requiredInput(
          ctx,
          "Region\n\nUse the region assigned to your bucket by the provider.",
          "us-east-1",
          signal,
        );
  if (!region || signal?.aborted) return false;
  const credentials = await chooseS3Credentials(ctx, signal);
  if (!credentials || signal?.aborted) return false;
  const saved = await saveReviewedDraft(
    ctx,
    "Review storage connection",
    [
      `Name: ${safeTerminalText(name)}`,
      `Type: ${preset}`,
      `Endpoint: ${safeTerminalText(endpoint)}`,
      `Region: ${safeTerminalText(region)}`,
      `Credentials: ${safeTerminalText(credentials.summary)}`,
      "Adding a connection does not contact remote storage or start syncing.",
    ],
    "Add storage connection",
    (saveSignal) =>
      addStorageConnection(
        name,
        {
          type: "s3",
          endpoint,
          region,
          credentials: {
            accessKeyId: credentials.profileFields.accessKeyId ?? "",
            secretAccessKey: credentials.profileFields.secretAccessKey ?? "",
          },
        },
        saveSignal,
      ),
    signal,
  );
  if (!saved) return false;
  if (signal?.aborted) return true;
  ctx.ui.notify(`Added storage connection “${safeTerminalText(name)}”.`, "info");
  return true;
}

function referencingSetups(raw: Record<string, unknown> | undefined, connection: string) {
  return Object.entries(ownRecord(raw?.syncSetups) ?? {})
    .filter(([, value]) => ownRecord(ownRecord(value)?.storage)?.connection === connection)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

export function connectionSummary(profile: Record<string, unknown>) {
  return `${connectionType(profile)} · ${connectionEndpoint(profile)}`;
}

function connectionType(profile: Record<string, unknown>) {
  if (profile.type === "git") return "Git";
  if (profile.type === "webdav") return "WebDAV";
  if (profile.type === "s3" && typeof profile.endpoint === "string" && isCloudflareR2Endpoint(profile.endpoint)) {
    return "Cloudflare R2";
  }
  return "S3-compatible";
}

function connectionEndpoint(profile: Record<string, unknown>) {
  const value = profile.type === "git" ? profile.remote : profile.type === "webdav" ? profile.url : profile.endpoint;
  if (typeof value !== "string" || value.length === 0) return "Missing";
  if (profile.type === "git") return safeTerminalText(value);
  try {
    const url = new URL(value);
    return safeTerminalText(`${url.origin}${url.pathname}`);
  } catch {
    return "Invalid";
  }
}

function credentialSource(profile: Record<string, unknown>) {
  if (profile.type === "git") return "Git credential helper or SSH configuration";
  const credentials = ownRecord(profile.credentials);
  if (profile.type === "webdav") return credentials?.password ? "Settings file" : "Missing";
  if (credentials?.accessKeyId && credentials.secretAccessKey) return "Settings file";
  return "Missing";
}
