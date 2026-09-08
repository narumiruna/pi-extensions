import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export async function implementationRuntime(extension?: ExtensionFactory, beforeBind?: () => void) {
	const root = mkdtempSync(join(tmpdir(), "plan-implementation-runtime-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	};
	let pi!: ExtensionAPI;
	let ctx!: ExtensionContext;
	let cancelReplacement = false;
	const events: string[] = [];
	const settings = SettingsManager.inMemory({
		defaultProvider: "plan-test",
		defaultModel: "planner",
		defaultThinkingLevel: "low",
		modelThinkingLevels: { "plan-test/worker": "medium" },
	});
	const factory: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd: root,
			agentDir: root,
			settingsManager: settings,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					{
						name: "implementation-test",
						factory: async (api) => {
							pi = api;
							await extension?.(api);
							api.on("session_start", (_event, context) => {
								ctx = context;
								events.push("start");
							});
							api.on("session_shutdown", () => {
								events.push("shutdown");
							});
							api.on("session_before_switch", () =>
								cancelReplacement ? { cancel: true } : undefined,
							);
							api.on("model_select", () => {
								events.push("model");
							});
							api.on("thinking_level_select", () => {
								events.push("thinking");
							});
						},
					},
				],
			},
		});
		services.modelRuntime.registerProvider("plan-test", {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "test-only",
			models: [
				{
					id: "planner",
					name: "planner",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100000,
					maxTokens: 1000,
				},
				{
					id: "worker",
					name: "worker",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100000,
					maxTokens: 1000,
					thinkingLevelMap: { low: null, xhigh: null, max: "max" },
				},
				{
					id: "plain",
					name: "plain",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100000,
					maxTokens: 1000,
				},
			],
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			tools: [],
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	try {
		runtime = await createAgentSessionRuntime(factory, {
			cwd: root,
			agentDir: root,
			sessionManager: SessionManager.inMemory(root),
		});
		const activeRuntime = runtime;
		const bind = async () =>
			activeRuntime.session.bindExtensions({
				mode: "rpc",
				commandContextActions: {
					waitForIdle: async () => {},
					newSession: (options) => activeRuntime.newSession(options),
					fork: (entryId, options) => activeRuntime.fork(entryId, options),
					switchSession: (path, options) => activeRuntime.switchSession(path, options),
					navigateTree: (id, options) => activeRuntime.session.navigateTree(id, options),
					reload: async () => {},
				},
			});
		activeRuntime.setRebindSession(bind);
		beforeBind?.();
		await bind();
		return {
			root,
			runtime: activeRuntime,
			settings,
			events,
			get pi() {
				return pi;
			},
			get ctx() {
				return ctx;
			},
			cancelReplacement() {
				cancelReplacement = true;
			},
			async dispose() {
				try {
					await activeRuntime.dispose();
				} finally {
					cleanup();
				}
			},
		};
	} catch (error) {
		await runtime?.dispose().catch(() => undefined);
		cleanup();
		throw error;
	}
}
