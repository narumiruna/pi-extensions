import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { readMergeAncestor } from "../src/state/merge-baseline-store.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { normalizeLocalFields, overlayLocalFields, portableSnapshot } from "../src/sync/local-fields.js";
import { pull, push, rollback, syncBoth } from "../src/sync/sync-mutations.js";
import { diff } from "../src/sync/sync-queries.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

const options: CommandOptions = {
  args: [],
  yes: true,
  force: false,
  stale: false,
  silent: false,
  reload: false,
  auto: false,
};
const image = (value: unknown) => snapshot([{ path: "settings.json", content: Buffer.from(JSON.stringify(value)) }]);
const object = (value: ReturnType<typeof image>) =>
  JSON.parse(Buffer.from(value.files[0]?.contentBase64 ?? "", "base64").toString());
for (const rules of [
  "x",
  ["x", "x"],
  ["__proto__"],
  ["bad\nfield"],
  ["defaultModel"],
  ["skills"],
  ["enableAnalytics"],
  ["trackingId"],
  [1],
]) {
  test(`invalid explicit exclusion: ${JSON.stringify(rules)}`, () => assert.throws(() => normalizeLocalFields(rules)));
}
test("analytics exclusions require both coupled fields in settings and portable snapshots", () => {
  for (const onlyOne of [["enableAnalytics"], ["trackingId"]]) {
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { localFields: onlyOne });
    assert.throws(() => validateSettingsDocument({ ...settings, version: 4 }), /excluded together/);
    assert.throws(
      () => portableSnapshot(image({ enableAnalytics: true, trackingId: "private" }), onlyOne),
      /excluded together/,
    );
  }
  const fields = ["enableAnalytics", "trackingId"];
  const projected = portableSnapshot(image({ enableAnalytics: true, trackingId: "private", theme: "dark" }), fields);
  assert.deepEqual(object(projected), { theme: "dark" });
  assert.deepEqual(
    object(overlayLocalFields(projected, image({ enableAnalytics: false, trackingId: "local" }), fields)),
    { theme: "dark", enableAnalytics: false, trackingId: "local" },
  );
});

test("portable projection omits exact fields and local overlay preserves values and absence", () => {
  const remote = portableSnapshot(image({ theme: "dark", machine: "remote-secret" }), ["machine"]);
  assert.deepEqual(object(remote), { theme: "dark" });
  assert.equal(remote.version, 2);
  assert.deepEqual(
    object(overlayLocalFields(remote, image({ theme: "light", machine: "local-secret" }), ["machine"])),
    { theme: "dark", machine: "local-secret" },
  );
  assert.deepEqual(object(overlayLocalFields(remote, image({ theme: "light" }), ["machine"])), { theme: "dark" });
  assert.throws(
    () => overlayLocalFields(snapshot([]), image({ machine: "keep" }), ["machine"]),
    /deletion requires manual review/,
  );
});
for (const include of [[], ["AGENTS.md"], ["sessions"], ["custom.json"], ["settings.json"], [" Settings.JSON "]]) {
  for (const localFields of [undefined, [], ["machine"]]) {
    test(`field policy requires managed settings: ${JSON.stringify(include)} / ${JSON.stringify(localFields)}`, () => {
      const settings = v3S3Settings({ include });
      if (localFields !== undefined) Object.assign(settings.syncSetups.home.sync, { localFields });
      const document = { ...settings, version: 4 };
      if (localFields?.length && !include.some((item) => item.trim().toLowerCase() === "settings.json"))
        assert.throws(() => validateSettingsDocument(document), /requires settings.json in sync.include/);
      else assert.equal(validateSettingsDocument(document).version, 4);
    });
  }
}

test("invalid unmanaged field-policy save preserves settings and unknown fields", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const settings = { ...v3S3Settings(), version: 4, future: { keep: true } };
    Object.assign(settings.syncSetups.home.sync, { localFields: ["machine"] });
    const bytes = JSON.stringify(settings);
    await fs.writeFile(localConfigPath(), bytes);
    const { updateLocalConfig } = await import("../src/settings/settings-store.js");
    await assert.rejects(
      updateLocalConfig((current) => {
        const setup = current.syncSetups.home;
        assert.ok(setup);
        return {
          ...current,
          syncSetups: { ...current.syncSetups, home: { ...setup, sync: { ...setup.sync, include: [] } } },
        };
      }),
      /requires settings.json/,
    );
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), bytes);
    assert.deepEqual((await loadConfig()).localFields, ["machine"]);
  }));

test("version 3 cannot silently enable machine-local policy", () => {
  const settings = v3S3Settings();
  Object.assign(settings.syncSetups.home.sync, { localFields: ["machine"] });
  assert.throws(() => validateSettingsDocument(settings), /version 4/);
  assert.equal(validateSettingsDocument({ ...settings, version: 4 }).version, 4);
});
async function machine(root: string, value: unknown) {
  process.env.PI_CODING_AGENT_DIR = root;
  await fs.mkdir(root, { recursive: true });
  const settings = v3S3Settings();
  Object.assign(settings.syncSetups.home.sync, { localFields: ["machine"], mergeSettings: true });
  await fs.writeFile(localConfigPath(), JSON.stringify({ ...settings, version: 4 }));
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(value));
  return createMockContext({ hasUI: true }).ctx;
}
test("two machines converge portable fields without upload, false conflict or local-value replacement", async () =>
  withTempHome(async (root) => {
    const backend = new MemorySyncBackend();
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const first = await machine(a, { theme: "light", machine: "A-private" });
    await push(first, options, undefined, () => backend);
    const second = await machine(b, { machine: "B-private" });
    await pull(second, options, () => backend);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(b, "settings.json"), "utf8")), {
      theme: "light",
      machine: "B-private",
    });
    await fs.writeFile(path.join(b, "settings.json"), JSON.stringify({ theme: "dark", machine: "B-new-private" }));
    await push(second, options, undefined, () => backend);
    process.env.PI_CODING_AGENT_DIR = a;
    await syncBoth(first, options, () => backend);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(a, "settings.json"), "utf8")), {
      theme: "dark",
      machine: "A-private",
    });
    await syncBoth(first, options, () => backend);
    const head = await backend.readHead();
    assert.ok(head);
    const remote = await backend.readSnapshot(head.snapshotRef);
    assert.doesNotMatch(Buffer.from(remote.files[0]?.contentBase64 ?? "", "base64").toString(), /private|machine/);
  }));
for (const localFields of [undefined, [], ["machine"]]) {
  test(`matching first sync captures accepted policy and ancestor: ${JSON.stringify(localFields)}`, async () =>
    withTempHome(async (root) => {
      const ctx = await machine(root, { theme: "base" });
      const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      if (localFields === undefined) {
        settings.version = 3;
        delete settings.syncSetups.home.sync.localFields;
      } else settings.syncSetups.home.sync.localFields = localFields;
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const backend = new MemorySyncBackend();
      const config = await loadConfig();
      const remote = portableSnapshot(
        { ...image({ theme: "base" }), selection: { version: 1, include: config.include } },
        localFields,
      );
      await backend.publishSnapshot(remote, { kind: "missing" });
      await syncBoth(ctx, options, () => backend);
      const state = await readStateForConfig(config);
      assert.deepEqual(state.localFields, localFields);
      assert.equal(
        (await readMergeAncestor(config, state, "settings.json"))?.toString(),
        Buffer.from(remote.files[0]?.contentBase64 ?? "", "base64").toString(),
      );
      await syncBoth(ctx, options, () => backend);
    }));
}

test("RPC pull, rollback and diff preview effective images, not excluded or formatting-only differences", async () =>
  withTempHome(async (root) => {
    const ctx = await machine(root, { theme: "dark", machine: "keep-private" });
    const original = await fs.readFile(path.join(root, "settings.json"), "utf8");
    const remote = portableSnapshot(image({ theme: "dark", machine: "never-upload" }), ["machine"]);
    const backend = new MemorySyncBackend();
    await backend.publishSnapshot(remote, { kind: "missing" });
    const notifications: string[] = [];
    const confirmations: string[] = [];
    const rpcContext = ctx as ExtensionContext;
    Object.assign(rpcContext, { mode: "rpc" });
    rpcContext.ui.notify = (message) => {
      notifications.push(message);
    };
    rpcContext.ui.confirm = async (_title, message) => {
      confirmations.push(message);
      return true;
    };
    await pull(ctx, { ...options, yes: false }, () => backend);
    await diff(ctx as Parameters<typeof diff>[0], options, () => backend);
    await rollback(ctx as Parameters<typeof rollback>[0], { ...options, yes: false, args: [remote.id] }, () => backend);
    assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), original);
    assert.match(notifications.join("\n"), /No file differences/);
    assert.doesNotMatch(confirmations.join("\n"), /Update locally: settings.json|keep-private|never-upload/);
  }));

test("unsupported settings recovery names supported versions without recommending a downgrade", () => {
  assert.throws(
    () => validateSettingsDocument({ ...v3S3Settings(), version: 999 }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /version 3, 4, 5 or 6/);
      assert.match(error.message, /do not downgrade/);
      assert.doesNotMatch(error.message, /create a new version 3/);
      return true;
    },
  );
});

test("migration cancellation and stale local review are mutation-free even with --yes", async () =>
  withTempHome(async (root) => {
    const backend = new MemorySyncBackend();
    const ctx = await machine(root, { theme: "base", machine: "keep" });
    await push(ctx, options, undefined, () => backend);
    const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
    settings.syncSetups.home.sync.localFields = [];
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const publication = vi.spyOn(backend, "publishSnapshot");
    (ctx as ExtensionContext).ui.confirm = async () => false;
    assert.equal(await push(ctx, { ...options, force: true }, undefined, () => backend), "cancelled");
    assert.equal(publication.mock.calls.length, 0);
    (ctx as ExtensionContext).ui.confirm = async () => {
      await fs.writeFile(path.join(root, "settings.json"), '{"theme":"newer","machine":"keep"}');
      return true;
    };
    await assert.rejects(
      push(ctx, { ...options, force: true }, undefined, () => backend),
      /Local content changed/,
    );
    assert.equal(publication.mock.calls.length, 0);
    assert.equal((await loadConfig()).localFields?.length, 0);
  }));
