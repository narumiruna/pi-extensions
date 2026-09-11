import type { AnySyncConfig } from "../settings/settings-types.js";
import { normalizeGitRemoteIdentity } from "./git/git-config.js";
import { normalizeWebDavIdentityUrl } from "./webdav/webdav-config.js";

export function backendIdentityCoordinates(config: AnySyncConfig) {
  switch (config.backend.type) {
    case "s3":
      return JSON.stringify([
        "s3",
        normalizeEndpointIdentity(config.backend.profile.endpoint),
        config.backend.destination.bucket,
        config.storagePath,
      ]);
    case "git":
      return JSON.stringify([
        "git",
        normalizeGitRemoteIdentity(config.backend.profile.remote),
        config.backend.destination.branch,
        config.storagePath,
      ]);
    case "webdav":
      return JSON.stringify([
        "webdav",
        normalizeWebDavIdentityUrl(config.backend.profile.url),
        config.backend.profile.username,
        config.storagePath,
      ]);
  }
}

export function normalizeEndpointIdentity(endpoint: string) {
  try {
    const url = new URL(endpoint.trim());
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/gu, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return endpoint.trim();
  }
}
