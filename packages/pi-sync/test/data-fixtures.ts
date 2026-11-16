import { createHash } from "node:crypto";

export function snapshot(files: Array<{ path: string; content: Buffer }>) {
  return {
    version: 1,
    id: "snap",
    createdAt: "2026-01-01T00:00:00.000Z",
    machine: "test",
    profile: "default",
    files: files.map((file) => ({
      path: file.path,
      contentBase64: file.content.toString("base64"),
      sha256: createHash("sha256").update(file.content).digest("hex"),
    })),
  };
}

export function v3S3Settings(
  options: { automatic?: boolean; include?: string[]; path?: string; bucket?: string; skipSecretScan?: boolean } = {},
) {
  return {
    version: 3,
    activeSyncSetup: "home",
    onSwitch: "ask-before-pull",
    skipSecretScan: options.skipSecretScan ?? false,
    storageConnections: {
      r2: {
        type: "s3",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
      },
    },
    syncSetups: {
      home: {
        storage: {
          connection: "r2",
          bucket: options.bucket ?? "pi-sync-test",
          path: options.path ?? "pi-sync/home",
        },
        sync: {
          include: options.include ?? ["settings.json"],
          automatic: options.automatic ?? false,
        },
      },
    },
  };
}

export function v3WebDavSettings(options: { automatic?: boolean; include?: string[] } = {}) {
  return {
    version: 3,
    activeSyncSetup: "home",
    onSwitch: "ask-before-pull",
    storageConnections: {
      dav: {
        type: "webdav",
        url: "https://cloud.example.com/dav",
        credentials: { username: "user", password: "pass" },
      },
    },
    syncSetups: {
      home: {
        storage: { connection: "dav", path: "pi-sync/home" },
        sync: {
          include: options.include ?? ["settings.json"],
          automatic: options.automatic ?? false,
        },
      },
    },
  };
}

/** Legacy flat fixture retained only by backend-unit tests that do not load settings. */
export function requiredConfig() {
  return {
    backend: "s3" as const,
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "pi-sync-test",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    extraFiles: [],
  };
}
