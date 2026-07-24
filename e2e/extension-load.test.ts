import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type RpcProcess, type RpcRecord, spawnPiRpc } from "./support/pi-rpc-harness.js";

interface ActivePackage {
	directory: string;
	entrypoint: string;
	name: string;
}

const root = process.cwd();
const controlExtension = path.join(root, "e2e", "fixtures", "control-extension.ts");
const expectedPackages = [
	"@narumitw/pi-accounts",
	"@narumitw/pi-btw",
	"@narumitw/pi-caffeinate",
	"@narumitw/pi-chrome-devtools",
	"@narumitw/pi-firecrawl",
	"@narumitw/pi-github-pr",
	"@narumitw/pi-goal",
	"@narumitw/pi-google-genai",
	"@narumitw/pi-image-drop",
	"@narumitw/pi-langfuse",
	"@narumitw/pi-lsp",
	"@narumitw/pi-plan-mode",
	"@narumitw/pi-retry",
	"@narumitw/pi-starship",
	"@narumitw/pi-statusline",
	"@narumitw/pi-subagents",
	"@narumitw/pi-sync",
	"@narumitw/pi-usage",
	"@narumitw/pi-webui",
	"@narumitw/pi-worktree",
] as const;
const activePackages = findActivePackages(path.join(root, "extensions"));

test("active extension E2E inventory is explicit and complete", () => {
	assert.deepEqual(
		activePackages.map((extensionPackage) => extensionPackage.name),
		expectedPackages,
	);
	for (const extensionPackage of activePackages) {
		assert.ok(existsSync(extensionPackage.entrypoint), `${extensionPackage.entrypoint} must exist`);
	}
});

for (const extensionPackage of activePackages) {
	test(`${extensionPackage.name} loads through Pi RPC and shuts down cleanly`, {
		timeout: 20_000,
	}, async (t) => {
		const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-extension-e2e-load-"));
		const cwd = path.join(temporaryRoot, "workspace");
		const agentDir = path.join(temporaryRoot, "agent");
		const sessionDir = path.join(temporaryRoot, "sessions");
		const sentinel = path.join(temporaryRoot, "shutdown.json");
		await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
		const rpc = spawnPiRpc({
			root,
			cwd,
			agentDir,
			sessionDir,
			extensionPaths: [extensionPackage.directory, controlExtension],
			env: { PI_E2E_SHUTDOWN_SENTINEL: sentinel },
			requestTimeoutMs: 10_000,
			shutdownTimeoutMs: 2_000,
		});
		t.after(async () => {
			await rpc.close();
			await rm(temporaryRoot, { recursive: true, force: true });
		});

		const state = await rpc.request({ type: "get_state" });
		assert.equal(state.success, true, rpc.diagnostics());
		const commands = await rpc.request({ type: "get_commands" });
		assert.equal(commands.success, true, rpc.diagnostics());
		assert.ok(commandNames(commands).includes("e2e-control"), rpc.diagnostics());

		await shutdown(rpc);
		const sentinelPayload = JSON.parse(await readFile(sentinel, "utf8")) as {
			reason: string;
		};
		assert.equal(sentinelPayload.reason, "quit");
		assert.deepEqual(
			rpc.records().filter((record) => record.type === "extension_error"),
			[],
			rpc.diagnostics(),
		);
		assert.doesNotMatch(
			rpc.stderr(),
			/(?:failed to load|extension[_ ]error|error loading extension)/i,
			rpc.diagnostics(),
		);
	});
}

async function shutdown(rpc: RpcProcess): Promise<void> {
	const notification = rpc.waitForRecord(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "notify" &&
			record.message === "PI_E2E_CONTROL shutting down",
		"control shutdown notification",
	);
	const response = await rpc.request({ type: "prompt", message: "/e2e-control shutdown" });
	assert.equal(response.success, true, rpc.diagnostics());
	await notification;
	await rpc.waitForExit(10_000);
	assert.deepEqual(rpc.exitStatus(), { code: 0, signal: null }, rpc.diagnostics());
}

function commandNames(response: RpcRecord): string[] {
	const data = response.data;
	if (!isRecord(data) || !Array.isArray(data.commands)) return [];
	return data.commands.flatMap((command) =>
		isRecord(command) && typeof command.name === "string" ? [command.name] : [],
	);
}

function findActivePackages(directory: string): ActivePackage[] {
	const packages: ActivePackage[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "node_modules") continue;
		const entryPath = path.join(directory, entry.name);
		const manifestPath = path.join(entryPath, "package.json");
		if (!existsSync(manifestPath)) {
			packages.push(...findActivePackages(entryPath));
			continue;
		}
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			name?: unknown;
			pi?: { extensions?: unknown };
		};
		assert.equal(typeof manifest.name, "string", `${manifestPath} must have a package name`);
		assert.deepEqual(
			manifest.pi?.extensions,
			["./src/index.ts"],
			`${manifest.name} must expose its canonical Pi entrypoint`,
		);
		packages.push({
			directory: entryPath,
			entrypoint: path.join(entryPath, "src", "index.ts"),
			name: manifest.name as string,
		});
	}
	return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
