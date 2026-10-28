import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { loadStarshipConfig } from "../src/config.js";
import { serializeEffectiveConfig } from "../src/effective-config.js";
import type { StatuslineInspection } from "../src/modules/inspection.js";
import { createSettingsDraft } from "../src/settings-draft.js";
import { settingsSnapshots } from "../src/settings-snapshots.js";

test("module snapshots retain authoritative states, reasons, metadata, and fixed opening values", async () => {
  const root = mkdtempSync(join(tmpdir(), "starship-module-snapshots-"));
  const path = join(root, "missing", "pi-starship.toml");
  const loaded = loadStarshipConfig(path);
  const inspection: StatuslineInspection = {
    modules: [
      {
        name: "model",
        description: "Current model",
        state: "Showing",
        preview: "model-id",
        variables: ["model"],
        styleFields: ["style"],
        styleRuleSelectors: ["provider"],
        styleRuleCount: 1,
        displayRules: [],
        rootReferenced: true,
        reachable: true,
        reason: "Rendered in the current footer",
      },
    ],
    showing: [],
  };
  inspection.showing = [...inspection.modules];
  const snapshots = settingsSnapshots(loaded, path, inspection);
  const draft = createSettingsDraft({
    settingsPath: path,
    baseline: undefined,
    packageRoot: resolve(import.meta.dirname, ".."),
    snapshots,
    isCurrent: () => true,
    onPreview() {
      assert.fail("Snapshot reads must not preview or collect");
    },
  });
  try {
    inspection.modules[0].reason = "Changed after opening";
    const result = await draft.tools[0].execute("modules", { path: join(draft.directory, "active-modules.json") });
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const snapshot = JSON.parse(text);
    assert.equal(snapshot.available, true);
    assert.match(snapshot.snapshot, /chat opening/u);
    assert.equal(snapshot.inspection.modules[0].reason, "Rendered in the current footer");
    assert.equal(snapshot.inspection.showing[0].preview, "model-id");
    assert.deepEqual(snapshot.inspection.modules[0].styleRuleSelectors, ["provider"]);
    assert.equal(snapshots["active-document.toml"], undefined);
    await assert.rejects(
      draft.tools[0].execute("raw", { path: join(draft.directory, "active-document.toml") }),
      /No exact loaded settings document/u,
    );
    await assert.rejects(draft.tools[0].execute("disk", { path }), /missing/u);
    assert.equal(JSON.parse(snapshots["active-state.json"]).loadedDocumentAvailable, false);
    assert.equal(JSON.parse(snapshots["active-state.json"]).source, "No settings file");
    assert.equal(existsSync(join(root, "missing")), false);
  } finally {
    draft.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("large runtime snapshots use bounded core reads with offset continuation", async () => {
  const path = "/tmp/starship-large-snapshot-absent.toml";
  const loaded = loadStarshipConfig(path);
  const snapshots = settingsSnapshots(loaded, path, undefined);
  snapshots["active-modules.json"] = Array.from({ length: 2500 }, (_, index) => `line-${index} ${"x".repeat(40)}`).join(
    "\n",
  );
  const draft = createSettingsDraft({
    settingsPath: path,
    baseline: undefined,
    packageRoot: resolve(import.meta.dirname, ".."),
    snapshots,
    isCurrent: () => true,
    onPreview() {},
  });
  try {
    const read = (offset?: number, limit?: number) =>
      draft.tools[0].execute("read", { path: join(draft.directory, "active-modules.json"), offset, limit });
    const result = await read();
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    // Core read appends its continuation notice after the bounded payload.
    assert.ok(result.details?.truncation?.truncated);
    assert.ok(Buffer.byteLength(result.details.truncation.content) <= 50 * 1024);
    assert.ok(result.details.truncation.outputLines <= 2000);
    assert.match(text, /Use offset/u);
    const tail = JSON.stringify((await read(2401, 3)).content);
    assert.match(tail, /line-2400/u);
    assert.doesNotMatch(tail, /line-2403/u);
  } finally {
    draft.dispose();
  }
});

test("active snapshots retain exact loaded text separately from normalized public TOML", () => {
  const root = mkdtempSync(join(tmpdir(), "starship-active-documents-"));
  const path = join(root, "pi-starship.toml");
  const raw = "# retained comment\r\nformat = '$model'\r\nfuture = true\r\n";
  writeFileSync(path, raw);
  try {
    const loaded = loadStarshipConfig(path);
    const normalized = serializeEffectiveConfig(loaded.config);
    const snapshots = settingsSnapshots(loaded, path, undefined);
    assert.equal(snapshots["active-document.toml"], raw);
    assert.equal(snapshots["active-effective.toml"], normalized);
    assert.match(normalized, /\[brand\]/u);
    assert.doesNotMatch(normalized, /future|retained comment|formatAst/u);
    writeFileSync(path, "format = '$directory'\n");
    loaded.config.format = "$provider";
    assert.equal(snapshots["active-document.toml"], raw);
    assert.equal(snapshots["active-effective.toml"], normalized);
    assert.equal(readFileSync(path, "utf8"), "format = '$directory'\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
