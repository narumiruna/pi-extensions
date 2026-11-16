export const KIMI_CODING_USAGE_API_KEY_ENV = "PI_USAGE_KIMI_CODING_API_KEY";

export interface KimiUsageCredential {
  apiKey: string;
  source: "environment" | "settings file";
}

/** Validate a literal Bearer token without guessing the provider's key format. */
export function normalizeKimiUsageApiKey(value: string): string | undefined {
  const key = value.trim();
  return key && /^[\x21-\x7e]+$/u.test(key) ? key : undefined;
}

/** A nonblank environment override wins; an invalid override must not select another account. */
export function readKimiUsageCredential(
  settingsApiKey: string | undefined,
  env: Record<string, string | undefined> = process.env,
): KimiUsageCredential | undefined {
  const override = env[KIMI_CODING_USAGE_API_KEY_ENV];
  const source = override?.trim() ? "environment" : "settings file";
  const value = source === "environment" ? override : settingsApiKey;
  if (!value?.trim()) return undefined;
  const apiKey = normalizeKimiUsageApiKey(value);
  if (!apiKey)
    throw new Error("The dedicated Kimi usage credential must be a printable ASCII token without whitespace.");
  return { apiKey, source };
}

/** Display only credential presence and source, including an unusable environment override. */
export function kimiUsageCredentialLabel(settingsApiKey: string | undefined): string {
  try {
    const credential = readKimiUsageCredential(settingsApiKey);
    return credential?.source === "environment" ? "Environment" : credential ? "Settings file" : "Missing";
  } catch {
    return "Environment (invalid)";
  }
}
