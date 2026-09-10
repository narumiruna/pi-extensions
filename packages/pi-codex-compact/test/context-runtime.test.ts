import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const fauxModuleSpecifier = "@earendil-works/pi-ai/providers/faux";

test("real Pi runtime settles, compacts, and starts one continuation turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-codex-context-runtime-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		await writeFile(
			join(agentDir, "pi-codex-compact.json"),
			`${JSON.stringify({ experimentalContextManagement: true })}\n`,
			"utf8",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const fauxModule = (await import(
			fauxModuleSpecifier
		)) as typeof import("@earendil-works/pi-ai/providers/faux");
		const faux = fauxModule.createFauxCore({
			api: `context-runtime-${crypto.randomUUID()}`,
			provider: `context-runtime-${crypto.randomUUID()}`,
			models: [{ id: "context-model", contextWindow: 100_000, maxTokens: 4_000 }],
		});
		const oldMarker = "OLD_WINDOW_PAYLOAD";
		faux.setResponses([
			fauxModule.fauxAssistantMessage(
				fauxModule.fauxToolCall("codex_compact_start_new_context", { reason: "runtime smoke" }),
			),
			(context) => {
				const serialized = JSON.stringify(context.messages);
				assert.match(serialized, /PI_CODEX_CONTEXT_WINDOW/);
				assert.doesNotMatch(serialized, new RegExp(oldMarker));
				return fauxModule.fauxAssistantMessage("continued after rollover");
			},
		]);

		const credentials = new InMemoryCredentialStore();
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const registry = new ModelRegistry(modelRuntime);
		registry.registerProvider(faux.getModel().provider, {
			api: faux.api,
			apiKey: "runtime-smoke",
			baseUrl: "http://localhost",
			streamSimple: faux.streamSimple,
			models: faux.models,
		});
		const model = registry.find(faux.getModel().provider, faux.getModel().id);
		assert.ok(model);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 1_000 },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [resolve("packages/pi-codex-compact/src/index.ts")],
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(cwd);
		const created = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			resourceLoader,
			sessionManager,
			settingsManager,
			noTools: "builtin",
		});
		session = created.session;
		assert.deepEqual(created.extensionsResult.errors, []);
		await session.bindExtensions({});
		await session.prompt(`${oldMarker}:${"x".repeat(24_000)}`);
		const deadline = Date.now() + 4_000;
		while (faux.state.callCount < 2 || !session.isIdle) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for rollover continuation");
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		}
		assert.equal(faux.state.callCount, 2);
		assert.equal(
			sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.fromHook)
				.length,
			1,
		);
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
