import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promptSecret } from "../secret-input.js";
import { requiredValueInput } from "./text-input.js";

export interface ChosenS3Credentials {
  profileFields: { accessKeyId?: string; secretAccessKey?: string };
  summary: string;
  ready: boolean;
  replace?: boolean;
}

export async function chooseS3CredentialUpdate(
  ctx: ExtensionCommandContext,
  profile: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const hasStored =
    typeof profile.accessKeyId === "string" &&
    profile.accessKeyId.length > 0 &&
    typeof profile.secretAccessKey === "string" &&
    profile.secretAccessKey.length > 0;
  if (hasStored) {
    const action = await ctx.ui.select("Credentials", ["Keep current credentials", "Replace credentials", "Cancel"], {
      signal,
    });
    throwIfAborted(signal);
    if (!action || action === "Cancel") return undefined;
    if (action === "Keep current credentials") {
      return { profileFields: {}, summary: "Unchanged (values hidden)", ready: true };
    }
  }
  const selected = await chooseS3Credentials(ctx, signal);
  return selected ? { ...selected, replace: true } : undefined;
}

export function applyS3CredentialUpdate(profile: Record<string, unknown>, credentials: ChosenS3Credentials) {
  const next = { ...profile };
  if (credentials.replace) {
    delete next.accessKeyId;
    delete next.secretAccessKey;
    delete next.sessionToken;
  }
  return { ...next, ...credentials.profileFields };
}

export async function chooseS3Credentials(
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<ChosenS3Credentials | undefined> {
  const choice = await ctx.ui.select(
    "Credentials\n\nCredentials are stored in the private pi-sync settings file. Secret values are masked during input and never shown afterward.",
    ["Store credentials privately", "Cancel"],
    { signal },
  );
  throwIfAborted(signal);
  if (choice !== "Store credentials privately") return undefined;
  const accessKeyId = await requiredValueInput(
    ctx,
    "Access key ID\n\nUse the S3 API access key ID issued by your provider, not the secret access key.",
    "access-key-id",
    signal,
  );
  if (!accessKeyId) return undefined;
  const secretAccessKey = await promptSecret(ctx, "Secret access key", { signal });
  throwIfAborted(signal);
  if (secretAccessKey === undefined) return undefined;
  return {
    profileFields: { accessKeyId, secretAccessKey },
    summary: "Stored privately (values hidden)",
    ready: true,
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
