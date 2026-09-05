import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	formatSkillsForPrompt,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(packageDirectory, "skills", "setting-up-pi-sync", "SKILL.md");

test("package declares and publishes the pi-sync setup skill", async () => {
	const manifest = JSON.parse(
		await readFile(path.join(packageDirectory, "package.json"), "utf8"),
	) as {
		files: string[];
		pi: { extensions: string[]; skills: string[] };
	};
	const rootManifest = JSON.parse(
		await readFile(path.join(packageDirectory, "..", "..", "package.json"), "utf8"),
	) as { pi: { skills: string[] } };

	assert.deepEqual(manifest.pi.extensions, ["./dist/index.ts"]);
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.ok(manifest.files.includes("skills"));
	assert.ok(rootManifest.pi.skills.includes("./packages/pi-sync/skills"));
});

test("Pi validates the bundled setup skill without diagnostics", async () => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "pi-sync-skill-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [packageDirectory] }),
			additionalSkillPaths: [skillPath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const skills = loader.getSkills();
		assert.deepEqual(skills.diagnostics, []);
		assert.equal(skills.skills[0]?.disableModelInvocation, true);
		assert.equal(formatSkillsForPrompt(skills.skills), "");
		assert.deepEqual(
			skills.skills.map(({ name }) => name),
			["setting-up-pi-sync"],
		);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("setup guidance protects secrets and requires a verified first transfer", async () => {
	const skill = await readFile(skillPath, "utf8");

	assert.match(skill, /^name: setting-up-pi-sync$/mu);
	assert.match(skill, /^description: .+first-time pi-sync setup\.$/mu);
	for (const requirement of [
		"Never ask the user to paste access keys",
		"Do not read or print `pi-sync.json`",
		"Keep sessions excluded",
		"/sync doctor",
		"Git diagnostics contact the remote",
		"WebDAV diagnostics contact the server",
		"S3 and R2 diagnostics are local-only",
		"do not validate the endpoint, bucket, credentials, permissions, or connectivity",
		"/sync push",
		"/sync pull",
		"without `--yes` or `--force`",
		"existing remote with authoritative local content",
		"**More… → Push to remote…**",
		"Do not choose **Sync now** when the user has explicitly chosen a direction",
		"**Use local as initial source…**",
		"**Keep local content and replace remote…**",
		"If a direct push or pull reports a conflict, return to `/sync`",
		"guarded forced operation internally after preview and confirmation",
		"session token when using temporary credentials",
		"**Store temporary credentials privately**",
		"session token in its masked prompt",
		"Change credential source**",
		"full repository path shown in **Endpoint**",
		"do not approve an exact Git destination from a host-only summary",
		"**More… → Sync setups…**",
		"complete collection URL in the sync-setup detail",
		"including for an already saved connection",
		"Adding or editing a setup does not necessarily make it current",
		"**Settings → After switching setup → Switch only**",
		"`/sync use <setup>` with the exact intended setup name",
		"If switching is declined or fails, stop",
		"verify the intended setup name is current before any doctor, status, diff, push, pull, or manager transfer",
		"defer any **Settings → Included content** adjustments until the intended setup is current",
		"New S3 and WebDAV setups added to existing settings start with automatic sync off",
		"turn **Settings → Automatic sync** off before restarting Pi",
		"first check `pi list`",
		"re-enable the pi-sync extension resource",
		"project overrides with Tab or `pi config -l`",
		"reinstalling preserves that filter",
		"Only when the package is absent",
		"Access key IDs and WebDAV usernames are visible during input",
		"warn the user before screen sharing or recording",
		"Report setup as complete only when",
	]) {
		assert.ok(skill.includes(requirement), `missing setup requirement: ${requirement}`);
	}
	assert.ok(!skill.includes("contacts the configured backend"));
	assert.ok(!skill.includes("because it masks credentials"));
	const readme = await readFile(path.join(packageDirectory, "README.md"), "utf8");
	assert.ok(readme.includes("access key IDs and WebDAV usernames remain visible during input"));
	assert.ok(!readme.includes("keeps credentials in masked extension prompts"));
});

for (const extensions of [[], ["-dist/index.ts"]]) {
	test(`package filter ${JSON.stringify(extensions)} can disable sync while retaining its skill`, async () => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-sync-filter-"));
		try {
			const settingsManager = SettingsManager.inMemory({
				packages: [{ source: packageDirectory, extensions }],
			});
			const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
			manager.addSourceToSettings(packageDirectory);
			assert.equal(manager.addSourceToSettings(packageDirectory), false);
			const packages = settingsManager.getGlobalSettings().packages;
			assert.equal(packages?.length, 1);
			assert.equal(typeof packages[0], "object");
			assert.deepEqual(typeof packages[0] === "object" && packages[0].extensions, extensions);
			const filtered = await manager.resolve();
			assert.ok(filtered.extensions.some((resource) => resource.path.endsWith("dist/index.ts")));
			assert.ok(filtered.extensions.every((resource) => !resource.enabled));
			assert.ok(filtered.skills.some((resource) => resource.enabled));

			settingsManager.setPackages([packageDirectory]);
			const enabled = await manager.resolve();
			assert.ok(
				enabled.extensions.some(
					(resource) => resource.enabled && resource.path.endsWith("dist/index.ts"),
				),
			);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
}
