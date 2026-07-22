import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLangfuseConfig, normalizeLangfuseConfig } from "../src/config.js";

test("loadLangfuseConfig reads pi-langfuse.json and enforces private permissions", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pi-langfuse.json");
	await writeFile(
		path,
		JSON.stringify({
			publicKey: "pk-from-file",
			secretKey: "sk-from-file",
			baseUrl: "http://self-hosted.example/",
			environment: "test",
			release: "v1",
			captureContent: false,
		}),
		{ mode: 0o644 },
	);

	const result = await loadLangfuseConfig(path);

	assert.deepEqual(result, {
		ok: true,
		config: {
			publicKey: "pk-from-file",
			secretKey: "sk-from-file",
			baseUrl: "http://self-hosted.example",
			environment: "test",
			release: "v1",
			captureContent: false,
		},
		path,
		warnings: [`Restricted ${path} permissions to 0600.`],
	});
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("loadLangfuseConfig reports missing and unsafe settings without environment fallbacks", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-missing-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pi-langfuse.json");

	assert.deepEqual(await loadLangfuseConfig(path), {
		ok: false,
		path,
		warnings: [],
		reason: `Configuration file not found: ${path}`,
	});

	await writeFile(path, JSON.stringify({ publicKey: "$LANGFUSE_PUBLIC_KEY", secretKey: "sk" }));
	const invalid = await loadLangfuseConfig(path);
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.reason, /publicKey must be literal/i);
});

test("configuration covers malformed JSON, normalization, and captureContent false", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-invalid-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pi-langfuse.json");
	await writeFile(path, "{broken", { mode: 0o600 });
	const malformed = await loadLangfuseConfig(path);
	assert.equal(malformed.ok, false);
	if (!malformed.ok) assert.match(malformed.reason, /failed to read/i);

	assert.deepEqual(
		normalizeLangfuseConfig({ publicKey: " pk ", secretKey: " sk ", baseUrl: "https://x.test///" }),
		{
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://x.test",
				captureContent: true,
			},
		},
	);
	for (const baseUrl of [
		"ftp://x",
		"https://user:password@x.test",
		"https://x.test?token=private",
		"https://x.test#private",
	]) {
		assert.equal(
			normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", baseUrl }).ok,
			false,
			baseUrl,
		);
	}
	assert.deepEqual(
		normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", captureContent: false }),
		{
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://us.cloud.langfuse.com",
				captureContent: false,
			},
		},
	);

	for (const environment of ["dev", "qa_2", "a".repeat(40)]) {
		const normalized = normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", environment });
		assert.equal(normalized.ok, true, environment);
	}
	for (const environment of [
		"Production",
		"with space",
		"langfuse",
		"langfuse-prod",
		"a".repeat(41),
	]) {
		const normalized = normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", environment });
		assert.equal(normalized.ok, false, environment);
		if (!normalized.ok) assert.match(normalized.reason, /environment/i);
	}

	await writeFile(path, JSON.stringify({ publicKey: "pk", secretKey: "sk" }), { mode: 0o600 });
	await chmod(path, 0o644);
	const repaired = await loadLangfuseConfig(path);
	assert.deepEqual(repaired.warnings, [`Restricted ${path} permissions to 0600.`]);
});
