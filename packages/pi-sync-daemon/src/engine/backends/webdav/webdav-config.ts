const DEFAULT_PATH = "pi-sync";

export function normalizeWebDavIdentityUrl(value: string) {
  try {
    const url = new URL(value.trim());
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function normalizeWebDavUrl(value: string | undefined) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Invalid pi-sync WebDAV URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid pi-sync WebDAV URL: credentials, query, and fragment are not allowed.");
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Invalid pi-sync WebDAV URL: HTTPS is required except for loopback.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url.toString();
}

export function normalizeWebDavPath(value: string | undefined) {
  if (value?.trim() === "." || value?.trim() === "./") return "./";
  const normalized = trimSlashes(normalizeOptionalString(value) ?? DEFAULT_PATH);
  if (
    !normalized ||
    normalized.includes("\\") ||
    hasControlCharacter(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid pi-sync WebDAV path.");
  }
  return normalized;
}

export function validateWebDavNamespace(value: string) {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || hasControlCharacter(value)) {
    throw new Error("Invalid pi-sync WebDAV namespace.");
  }
}

export function validateWebDavCredentials(username: string, password?: string) {
  if (
    username.includes(":") ||
    hasControlCharacter(username) ||
    (password !== undefined && hasControlCharacter(password))
  ) {
    throw new Error("Invalid pi-sync WebDAV credentials.");
  }
}

function normalizeOptionalString(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/gu, "");
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}
