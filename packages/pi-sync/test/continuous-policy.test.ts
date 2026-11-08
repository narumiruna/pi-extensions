import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { S3HttpError } from "../src/backends/s3/s3-client.js";
import { SyncBackendConflictError } from "../src/backends/sync-backend.js";
import { WebDavHttpError } from "../src/backends/webdav/webdav-client.js";
import { loadConfig, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath, withConfigReplacementInstalledHookForTest } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { ContinuousError, continuousFailure, retryAfter } from "../src/sync/continuous-errors.js";
import { continuousEnabled } from "../src/sync/continuous-sync.js";
import { saveContinuousMode } from "../src/ui/agent-mode-setting.js";
import { requiredHome } from "./continuous-test-helpers.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const [error, kind, retry] of [
  [new S3HttpError("secret", 503), "transient", true],
  [new WebDavHttpError("secret", 429), "transient", true],
  [new S3HttpError("secret", 401), "authentication", false],
  [new WebDavHttpError("secret", 403), "authentication", false],
  [new S3HttpError("secret", 400), "unknown", false],
  [new Error("outer", { cause: Object.assign(new Error("secret"), { code: "ECONNREFUSED" }) }), "transient", true],
  [Object.assign(new Error("secret"), { code: "ELOCKED" }), "contention", true],
  [Object.assign(new Error("secret"), { code: "ECOMPROMISED" }), "stale", true],
  [Object.assign(new Error("secret"), { code: "ENOSPC" }), "storage", false],
  [new SyncBackendConflictError("secret"), "stale", true],
  [new DOMException("secret", "TimeoutError"), "transient", true],
  [new DOMException("secret", "AbortError"), "unknown", false],
  [new Error("HTTP 503 ECONNRESET"), "unknown", false],
  [new ContinuousError("unsafe", "secret"), "unsafe", false],
  [new ContinuousError("model", "secret"), "model", false],
  [new ContinuousError("budget", "secret", 900_000), "budget", true],
] as const)
  test(`background category ${kind}/${String(error)}`, () => {
    const result = continuousFailure(error);
    assert.equal(result.kind, kind);
    assert.equal(result.retry, retry);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

test("retry delay parsing is bounded and rejects invalid values", () => {
  for (const [value, expected] of [
    ["20", 20_000],
    ["1000000", 300_000],
    ["-1", undefined],
    ["invalid", undefined],
    ["Infinity", undefined],
  ] as const)
    assert.equal(retryAfter(new Response(null, { headers: { "retry-after": value } })), expected);
  const time = Date.now();
  const delay = retryAfter(new Response(null, { headers: { "retry-after": new Date(time + 60_000).toUTCString() } }));
  assert.ok(delay !== undefined && delay <= 60_000 && delay >= 58_000);
  const circular = new Error("unknown");
  circular.cause = circular;
  assert.deepEqual(continuousFailure(circular), { kind: "unknown", retry: false });
});

for (const version of [3, 4, 5])
  test(`continuous setting is additive and separate in schema ${version}`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = { ...v3S3Settings(), version, unknown: "keep" };
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const before = await loadConfig();
      assert.equal(before.continuous, false);
      assert.equal(continuousEnabled(before), false);
      await updateLocalConfig((current) => ({
        ...current,
        syncSetups: {
          ...current.syncSetups,
          home: { ...requiredHome(current), sync: { ...requiredHome(current).sync, continuous: true } },
        },
      }));
      const after = await loadConfig();
      assert.equal(after.agentMode, false);
      assert.equal(continuousEnabled(after), false);
      assert.notEqual(syncConfigReviewFingerprint(before), syncConfigReviewFingerprint(after));
      assert.equal(JSON.parse(await fs.readFile(localConfigPath(), "utf8")).unknown, "keep");
      for (const invalid of ["true", 1, null, [], {}]) {
        const document = structuredClone(settings);
        Object.assign(document.syncSetups.home.sync, { continuous: invalid });
        assert.throws(() => validateSettingsDocument(document), /continuous.*boolean/);
      }
    }));

for (const decision of ["approve", "cancel", "done", "stale", "abort-after-publication"] as const)
  test(`continuous consent ${decision} binds setup and preserves committed writes`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = v3S3Settings();
      Object.assign(settings.syncSetups.home.sync, { agentMode: true });
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const controller = new AbortController();
      let title = "";
      let choices: string[] = [];
      const mock = createMockContext({
        mode: "rpc",
        select: async (text: string, options: string[]) => {
          title = text;
          choices = options;
          if (decision === "stale")
            await updateLocalConfig((current) => ({
              ...current,
              syncSetups: {
                ...current.syncSetups,
                home: { ...requiredHome(current), sync: { ...requiredHome(current).sync, automatic: true } },
              },
            }));
          return decision === "cancel" ? "No, cancel" : decision === "done" ? "Done" : "Yes, Enable Continuous sync";
        },
      });
      const save = () => saveContinuousMode(mock.ctx, "home", true, controller.signal);
      if (decision === "stale") await assert.rejects(save(), /changed/);
      else if (decision === "abort-after-publication")
        assert.equal(await withConfigReplacementInstalledHookForTest(async () => controller.abort(), save), true);
      else assert.equal(await save(), decision === "approve");
      const stored = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      assert.equal(
        Boolean(stored.syncSetups.home.sync.continuous),
        decision === "approve" || decision === "abort-after-publication",
      );
      assert.match(title, /^Enable Continuous sync\?/);
      assert.deepEqual(choices, ["No, cancel", "Yes, Enable Continuous sync", "View details", "Done"]);
      assert.match(title, /Requires Autonomous sync/);
      assert.match(title, /60–66 seconds/);
      assert.match(title, /15-minute window/);
      assert.match(title, /different provider\/model/);
      assert.match(title, /model\/storage costs/);
      assert.match(title, /No automatic reload/);
      assert.match(title, /No transfer starts from Settings/);
      assert.match(title, /request bounds, not a currency cap/);
      assert.doesNotMatch(title, /secret-key|experimental|agent[ -]mode/i);
    }));

test("continuous cannot enable Agent mode and disabling needs no new consent", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
    const mock = createMockContext({
      mode: "rpc",
      select: async () => {
        throw new Error("unexpected consent");
      },
    });
    await assert.rejects(saveContinuousMode(mock.ctx, "home", true), /Enable Autonomous sync/);
    await updateLocalConfig((current) => ({
      ...current,
      syncSetups: {
        ...current.syncSetups,
        home: { ...requiredHome(current), sync: { ...requiredHome(current).sync, continuous: true } },
      },
    }));
    assert.equal(await saveContinuousMode(mock.ctx, "home", false), true);
    assert.equal((await loadConfig()).continuous, false);
    await fs.writeFile(localConfigPath(), "{broken");
    await assert.rejects(saveContinuousMode(mock.ctx, "home", false));
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), "{broken");
    await assert.rejects(fs.stat(path.join(agentDir, "pi-sync", "continuous")), /ENOENT/);
  }));
