import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizePlanModeSettings, readPlanModeSettings } from "../src/settings.js";

test("Plan-mode settings validate inherit and fixed thinking levels", async () => {
	assert.deepEqual(normalizePlanModeSettings({}), { thinkingLevel: "inherit" });
	assert.deepEqual(normalizePlanModeSettings({ thinkingLevel: "medium" }), {
		thinkingLevel: "medium",
	});
	assert.deepEqual(normalizePlanModeSettings({ thinkingLevel: "max" }), {
		thinkingLevel: "max",
	});
	assert.equal(normalizePlanModeSettings({ thinkingLevel: "extreme" }), undefined);

	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-test-"));
	try {
		const path = join(directory, "pi-plan-mode.json");
		await writeFile(path, '{"thinkingLevel":"high"}');
		assert.deepEqual(await readPlanModeSettings(path), {
			kind: "loaded",
			settings: { thinkingLevel: "high" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings normalize default tool names strictly", async () => {
	assert.deepEqual(
		normalizePlanModeSettings({
			thinkingLevel: "medium",
			defaultPlanTools: ["bash", "read", "bash", "grep"],
		}),
		{
			thinkingLevel: "medium",
			defaultPlanTools: ["bash", "read", "grep"],
		},
	);
	assert.deepEqual(normalizePlanModeSettings({ defaultPlanTools: [] }), {
		thinkingLevel: "inherit",
		defaultPlanTools: [],
	});
	for (const defaultPlanTools of ["read", [""], ["   "], ["read", 42]]) {
		assert.equal(normalizePlanModeSettings({ defaultPlanTools }), undefined);
	}

	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-default-tools-test-"));
	try {
		const path = join(directory, "pi-plan-mode.json");
		await writeFile(path, '{"defaultPlanTools":["read","bash","read"]}');
		assert.deepEqual(await readPlanModeSettings(path), {
			kind: "loaded",
			settings: {
				thinkingLevel: "inherit",
				defaultPlanTools: ["read", "bash"],
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings validate safe subcommands strictly", async () => {
	assert.deepEqual(
		normalizePlanModeSettings({
			thinkingLevel: "medium",
			defaultPlanTools: ["read", "bash"],
			safeSubcommands: {
				git: ["status", "rev-parse", "status", "cat-file"],
				gh: ["pr view", "issue list", "pr view"],
			},
		}),
		{
			thinkingLevel: "medium",
			defaultPlanTools: ["read", "bash"],
			safeSubcommands: {
				git: ["status", "rev-parse", "cat-file"],
				gh: ["pr view", "issue list"],
			},
		},
	);
	assert.deepEqual(normalizePlanModeSettings({ safeSubcommands: {} }), {
		thinkingLevel: "inherit",
		safeSubcommands: {},
	});
	assert.deepEqual(normalizePlanModeSettings({ safeSubcommands: { git: [], gh: [] } }), {
		thinkingLevel: "inherit",
		safeSubcommands: { git: [], gh: [] },
	});

	for (const safeSubcommands of [
		null,
		[],
		{ kubectl: ["get"] },
		{ git: "status" },
		{ git: ["checkout"] },
		{ git: ["status", 42] },
		{ gh: ["pr merge"] },
		{ gh: ["pr view", ""] },
	]) {
		assert.equal(normalizePlanModeSettings({ safeSubcommands }), undefined);
	}
});

test("Plan-mode settings migrate to the canonical package filename", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(
			join(directory, "plan-mode.json"),
			'{"thinkingLevel":"high","safeSubcommands":{"gh":["pr view"]},"futureOption":true}',
		);
		const loaded = await readPlanModeSettings();
		assert.equal(loaded.kind, "loaded");
		assert.match(loaded.notice ?? "", /migrated/i);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "pi-plan-mode.json"), "utf8")), {
			thinkingLevel: "high",
			safeSubcommands: { gh: ["pr view"] },
			futureOption: true,
		});
		await assert.rejects(access(join(directory, "plan-mode.json")));

		await writeFile(join(directory, "plan-mode.json"), '{"thinkingLevel":"low"}');
		await writeFile(join(directory, "pi-plan-mode.json"), '{"thinkingLevel":"medium"}');
		const preferred = await readPlanModeSettings();
		assert.deepEqual(preferred.kind === "loaded" ? preferred.settings : undefined, {
			thinkingLevel: "medium",
		});
		assert.match(preferred.notice ?? "", /ignored/i);

		await writeFile(join(directory, "pi-plan-mode.json"), "invalid");
		const invalid = await readPlanModeSettings();
		assert.equal(invalid.kind, "invalid");
		assert.equal(
			await readFile(join(directory, "plan-mode.json"), "utf8"),
			'{"thinkingLevel":"low"}',
		);

		await unlink(join(directory, "pi-plan-mode.json"));
		await writeFile(join(directory, "plan-mode.json"), "invalid");
		assert.equal((await readPlanModeSettings()).kind, "invalid");
		await assert.rejects(access(join(directory, "pi-plan-mode.json")));

		await writeFile(join(directory, "plan-mode.json"), '{"thinkingLevel":"high"}');
		await symlink("missing-target", join(directory, "pi-plan-mode.json"));
		const fallback = await readPlanModeSettings();
		assert.deepEqual(fallback.kind === "loaded" ? fallback.settings : undefined, {
			thinkingLevel: "high",
		});
		assert.match(fallback.notice ?? "", /migration failed/i);
		assert.equal(
			await readFile(join(directory, "plan-mode.json"), "utf8"),
			'{"thinkingLevel":"high"}',
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});
