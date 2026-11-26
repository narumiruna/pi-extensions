import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import * as consent from "../src/consent.js";
import { configureEngineHost } from "../src/engine/host.js";
import { createLegacyConsentGuard } from "../src/legacy-consent-guard.js";

async function fixture(run: (file: string, root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-legacy-consent-")));
  configureEngineHost({ root: () => root, mutate: (_target, action) => action(), review: async () => false });
  try {
    await fs.mkdir(path.join(root, "pi-sync"), { mode: 0o700 });
    await fs.writeFile(
      path.join(root, "pi-sync.json"),
      JSON.stringify({
        version: 3,
        onSwitch: "switch-only",
        activeSyncSetup: "home",
        storageConnections: { git: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
        syncSetups: {
          home: {
            storage: { connection: "git", path: "./", branch: "main" },
            sync: { include: ["AGENTS.md"], automatic: false, agentMode: true, continuous: true },
          },
        },
      }),
      { mode: 0o600 },
    );
    await run(path.join(root, "pi-sync", "daemon.json"), root);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function grant(file: string, root: string) {
  const raw = JSON.stringify({
    version: 1,
    root,
    handover: true,
    nonce: "a".repeat(64),
    setups: { home: { fingerprint: "b".repeat(64), afterExit: true } },
    future: { retained: true },
  });
  await fs.writeFile(file, raw, { mode: 0o600 });
  return raw;
}

test("missing or retained unattended consent does not keep an idle retired daemon alive", () =>
  fixture(async (file, root) => {
    const guard = createLegacyConsentGuard(root);
    assert.equal(await guard.lifetime(), "exit");
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
    const raw = await grant(file, root);
    assert.equal(await guard.lifetime(), "exit");
    assert.equal(await fs.readFile(file, "utf8"), raw);
  }));

for (const failure of ["consent", "settings"] as const)
  test(`uncertain ${failure} reads pause lifetime without rewriting evidence`, () =>
    fixture(async (file, root) => {
      await grant(file, root);
      const target = failure === "consent" ? file : path.join(root, "pi-sync.json");
      await fs.writeFile(target, "{invalid", { mode: 0o600 });
      assert.equal(await createLegacyConsentGuard(root).lifetime(), "pause");
      assert.equal(await fs.readFile(target, "utf8"), "{invalid");
    }));

test("a cleanup or revocation failure retains both evidence and the recovery barrier", () =>
  fixture(async (file, root) => {
    const raw = await grant(file, root);
    const guard = createLegacyConsentGuard(root);
    guard.block();
    assert.equal(await guard.lifetime(), "pause");
    assert.equal(guard.allowsRecovery(), false);
    const other = createLegacyConsentGuard(root);
    vi.spyOn(consent, "revokeChangedBindings").mockImplementation(() => {
      throw new consent.ConsentPublicationError("fixture failure");
    });
    assert.throws(() => other.factsChanged([]), /authorization could not be saved/u);
    assert.equal(await other.lifetime(), "pause");
    assert.equal(other.allowsRecovery(), false);
    assert.equal(await fs.readFile(file, "utf8"), raw);
  }));
