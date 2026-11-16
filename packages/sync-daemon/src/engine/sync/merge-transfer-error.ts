import type { ResolvedSyncBackend } from "../backends/backend-types.js";
import { safeTerminalText } from "../ui/terminal-text.js";

const MAX_CAUSES = 4;
const MAX_DETAIL_LENGTH = 600;

/** Only the sanitized message is displayed; retain the original cause for outcome handling. */
export function mergeTransferError(error: unknown, backend: ResolvedSyncBackend): Error {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current) && seen.size < MAX_CAUSES) {
    seen.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    const status = (current as Error & { status?: unknown }).status;
    const metadata = [
      typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : undefined,
      typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? `HTTP ${status}`
        : undefined,
    ].filter(Boolean);
    const message = `${current.message}${metadata.length ? ` (${metadata.join(", ")})` : ""}`;
    if (message && !messages.includes(message)) messages.push(message);
    current = current.cause;
  }
  let detail = messages.join(" → ") || "No error details available.";
  // Redact before truncation or terminal escaping, including overlapping and encoded credentials.
  for (const secret of credentialVariants(backend)) detail = detail.replaceAll(secret, "[REDACTED]");
  detail = detail.replace(/\b(Bearer|Basic)\s+[^\s<>"']+/giu, "$1 [REDACTED]");
  detail = safeTerminalText(detail);
  if (detail.length > MAX_DETAIL_LENGTH) detail = `${detail.slice(0, MAX_DETAIL_LENGTH)}… (details truncated)`;
  return new Error(
    `Merged transfer interrupted; journal and backup retained. Run /sync sync to reconcile before further mutations. Transfer failure: ${detail}`,
    { cause: error },
  );
}

function credentialVariants(backend: ResolvedSyncBackend): string[] {
  const secrets: string[] = [];
  let address: string;
  switch (backend.type) {
    case "s3":
      secrets.push(backend.profile.accessKeyId, backend.profile.secretAccessKey, backend.profile.sessionToken ?? "");
      address = backend.profile.endpoint;
      break;
    case "webdav":
      secrets.push(
        backend.profile.username,
        backend.profile.password,
        Buffer.from(`${backend.profile.username}:${backend.profile.password}`).toString("base64"),
      );
      address = backend.profile.url;
      break;
    case "git":
      address = backend.profile.remote;
      break;
  }
  try {
    const url = new URL(address);
    secrets.push(url.username, url.password, ...url.searchParams.values());
    for (const value of [url.username, url.password]) secrets.push(decodeURIComponent(value));
  } catch {
    // Git SSH shorthand is not a URL; configured Git remotes cannot contain credentials.
  }
  return [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]),
    ),
  ].sort((left, right) => right.length - left.length);
}
