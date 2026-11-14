import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { ignoreFromLegacyIncludes, normalizeSyncIgnore } from "../sync/sync-ignore.js";
import { normalizeSyncInclude } from "../sync/sync-policy.js";
import { configFromSettings, syncCheckConfigFingerprint } from "./config.js";
import { localConfigPath } from "./config-file.js";
import { updateLocalConfig } from "./settings-store.js";
import type { AnySyncConfig, PiSyncSettingsV3 } from "./settings-types.js";
import { publishSyncIgnore, readSyncIgnoreFile } from "./sync-ignore-file.js";

export { readSyncIgnoreFile, syncIgnorePath } from "./sync-ignore-file.js";

export function migrationSyncIgnore(settings: PiSyncSettingsV3) {
  return ignoreFromLegacyIncludes(
    Object.values(settings.syncSetups).map((setup) => normalizeSyncInclude(setup.sync.include)),
  );
}

/** Explicit reviewed migration of all setups; publication failure leaves legacy selection active. */
export function migrateToSyncIgnore(
  expected: PiSyncSettingsV3,
  expectedIgnore: string | undefined,
  signal?: AbortSignal,
) {
  return updateLocalConfig(async (current) => {
    if (current.version === 6 || !isDeepStrictEqual(current, expected))
      throw new Error("Settings changed; reopen the .syncignore migration review.");
    const text = migrationSyncIgnore(current);
    if (expectedIgnore !== undefined && expectedIgnore !== text)
      throw new Error(
        "An existing .syncignore differs from the migration. Preserve it elsewhere before migrating; no files were changed.",
      );
    const original = `${JSON.stringify(current, null, 2)}\n`;
    const backup = `${localConfigPath()}.${createHash("sha256").update(original).digest("hex").slice(0, 16)}.before-syncignore`;
    try {
      const handle = await fs.open(backup, "wx", 0o600);
      try {
        await handle.writeFile(original);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await fs.lstat(backup)).isFile() || (await fs.readFile(backup, "utf8")) !== original)
        throw new Error("Migration backup is not the expected regular file; preserve it and review recovery.");
    }
    signal?.throwIfAborted();
    await publishSyncIgnore(text, expectedIgnore, signal);
    // Nothing after policy publication may silently expand legacy scope. The conservative
    // rules can remain inert if JSON publication fails and a retry can reuse them.
    const syncSetups = Object.fromEntries(
      Object.entries(current.syncSetups).map(([name, setup]) => {
        const { include: _include, ...sync } = setup.sync;
        return [name, { ...setup, sync }];
      }),
    );
    return { ...current, version: 6, syncSetups };
  }, signal);
}

/** Shares the complete ordered settings mutation and cross-process lock with every JSON writer. */
export function saveSyncIgnore(
  text: string,
  expected: string | undefined,
  signal?: AbortSignal,
  expectedConfig?: AnySyncConfig,
) {
  normalizeSyncIgnore(text);
  return updateLocalConfig(async (current) => {
    if (current.version !== 6) throw new Error("Migrate legacy sync.include settings before editing .syncignore.");
    if (
      expectedConfig &&
      syncCheckConfigFingerprint(
        configFromSettings(current, expectedConfig.setupName, (await readSyncIgnoreFile()) ?? ""),
      ) !== syncCheckConfigFingerprint(expectedConfig)
    )
      throw new Error("Sync setup changed; reopen the remote-policy review.");
    await publishSyncIgnore(text, expected, signal);
    return current;
  }, signal);
}
