import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function goalFauxProvider(pi: ExtensionAPI): Promise<void> {
	const repositoryRoot = process.env.PI_E2E_REPOSITORY_ROOT;
	assert.ok(repositoryRoot, "PI_E2E_REPOSITORY_ROOT must identify the E2E checkout");
	const fauxModuleUrl = pathToFileURL(
		path.join(
			repositoryRoot,
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"providers",
			"faux.js",
		),
	).href;
	const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import(fauxModuleUrl);
	const faux = createFauxCore({ api: "e2e-faux", provider: "e2e-faux" });
	const provider = faux.getModel().provider;
	faux.setResponses([
		fauxAssistantMessage("The deterministic E2E first pass requests one continuation."),
		(context: { systemPrompt?: string }) => {
			const goalId = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/.exec(context.systemPrompt ?? "")?.[1];
			assert.ok(goalId, "expected the active goal id in the continuation system prompt");
			return fauxAssistantMessage(
				fauxToolCall("goal_complete", {
					goal_id: goalId,
					summary: "Deterministic CLI E2E completion verified the runtime flow.",
				}),
			);
		},
	]);
	pi.registerProvider(provider, {
		api: faux.api,
		apiKey: "e2e-only",
		baseUrl: "http://localhost",
		streamSimple: faux.streamSimple,
		models: faux.models.map(
			(model: {
				id: string;
				name: string;
				api: string;
				baseUrl: string;
				reasoning: boolean;
				input: Array<"text" | "image">;
				cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
				contextWindow: number;
				maxTokens: number;
			}) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}),
		),
	});
}
