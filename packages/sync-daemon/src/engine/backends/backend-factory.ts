import type { AnySyncConfig } from "../settings/settings-types.js";
import type { SyncBackend } from "./sync-backend.js";

export type SyncBackendFactory = {
  bivarianceHack(config: AnySyncConfig): SyncBackend | Promise<SyncBackend>;
}["bivarianceHack"];

export const createSyncBackend: SyncBackendFactory = async (config) => {
  switch (config.backend.type) {
    case "s3": {
      const { S3SyncBackend } = await import("./s3/s3-backend.js");
      return new S3SyncBackend(config.backend);
    }
    case "webdav": {
      const { WebDavSyncBackend } = await import("./webdav/webdav-backend.js");
      return new WebDavSyncBackend(config.backend);
    }
    case "git": {
      const { GitSyncBackend } = await import("./git/git-backend.js");
      return new GitSyncBackend(config.backend);
    }
  }
};
