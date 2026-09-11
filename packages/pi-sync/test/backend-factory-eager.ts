import { GitSyncBackend } from "../src/backends/git/git-backend.js";
import { S3SyncBackend } from "../src/backends/s3/s3-backend.js";
import type { SyncBackend } from "../src/backends/sync-backend.js";
import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import type { AnySyncConfig } from "../src/settings/settings-types.js";

export function createSyncBackend(config: AnySyncConfig): SyncBackend {
  switch (config.backend.type) {
    case "s3":
      return new S3SyncBackend(config.backend);
    case "webdav":
      return new WebDavSyncBackend(config.backend);
    case "git":
      return new GitSyncBackend(config.backend);
  }
}
