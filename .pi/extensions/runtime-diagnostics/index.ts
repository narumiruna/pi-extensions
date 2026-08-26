import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CaptureControlAction,
	CONTROL_ENTRY_TYPE,
	createCaptureState,
	createControlEntry,
	finalizePendingRequests,
	MAX_CAPTURE_AGE_MINUTES,
	MAX_CAPTURE_RECORDS,
	PROVIDER_REQUEST_ENTRY_TYPE,
	PROVIDER_RESPONSE_ENTRY_TYPE,
	type ProviderCaptureState,
	pruneCaptureState,
	restoreCaptureState,
} from "./capture-state.js";
import {
	attachProviderResponse,
	createProviderResponseDiagnostic,
	extractProviderRequestDiagnostic,
} from "./provider-request.js";
import {
	boundDiagnosticResponse,
	createDiagnosticResponse,
	DIAGNOSTIC_ACTIONS,
	DIAGNOSTIC_DETAILS,
	DIAGNOSTIC_SECTIONS,
	type DiagnosticAction,
	type DiagnosticSection,
	formatCommandSummary,
} from "./report.js";
import {
	createRuntimeSnapshot,
	RUNTIME_ENTRY_TYPE,
	type RuntimeSnapshotReason,
	runtimeStateSignature,
} from "./snapshot.js";

export { CONTROL_ENTRY_TYPE, PROVIDER_REQUEST_ENTRY_TYPE, PROVIDER_RESPONSE_ENTRY_TYPE };

const TOOL_NAME = "runtime_diagnostics";
const COMMAND_NAME = "runtime-diagnostics";
const MAX_SHOW_RECORDS = 20;
const COMMAND_ROUTES = [
	"status",
	"provider",
	"cache",
	"tools",
	"extensions",
	"privacy",
	"help",
] as const;
type CommandRoute = (typeof COMMAND_ROUTES)[number];

interface DebugDependencies {
	now(): number;
}

export function createDebugExtension(
	dependencies: Partial<DebugDependencies> = {},
): (pi: ExtensionAPI) => void {
	const now = dependencies.now ?? Date.now;
	return function debugExtension(pi: ExtensionAPI): void {
		let capture: ProviderCaptureState = createCaptureState();
		let lastRuntimeSignature: string | undefined;

		pi.registerTool({
			name: TOOL_NAME,
			label: "Runtime Diagnostics",
			description:
				"Inspect and manage privacy-filtered runtime diagnostics for model routing, cache performance, tool availability and provenance, visible extension surfaces, provider request exposure and timing, retention, comparisons, and shareable bundles. Output is bounded to 50 KB and 2,000 lines.",
			promptSnippet:
				"Inspect model, cache, tool, extension-surface, and provider-request diagnostics",
			promptGuidelines: [
				"Use runtime_diagnostics when model routing, prompt caching, tool availability, deferred tool loading, provider exposure, or extension registration may be misconfigured.",
				"Start with runtime_diagnostics status and request full or selected sections only when the concise findings need more evidence.",
			],
			parameters: Type.Object({
				action: Type.Optional(
					StringEnum(DIAGNOSTIC_ACTIONS, {
						description:
							"status (default), capture controls, latest/show/compare, retention configure, or a full sanitized bundle",
					}),
				),
				detail: Type.Optional(
					StringEnum(DIAGNOSTIC_DETAILS, {
						description: "summary (default) or full diagnostic detail",
					}),
				),
				sections: Type.Optional(
					Type.Array(StringEnum(DIAGNOSTIC_SECTIONS), {
						uniqueItems: true,
						maxItems: DIAGNOSTIC_SECTIONS.length,
						description: "Optional detail sections to include without requesting the full report",
					}),
				),
				limit: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: MAX_SHOW_RECORDS,
						description: "Maximum provider-request records returned by show or bundle",
					}),
				),
				maxRecords: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: MAX_CAPTURE_RECORDS,
						description: "configure only: maximum records in the active reporting window",
					}),
				),
				maxAgeMinutes: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: MAX_CAPTURE_AGE_MINUTES,
						description: "configure only: maximum record age in the active reporting window",
					}),
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const action: DiagnosticAction = params.action ?? "status";
				validateRetentionParameters(action, params.maxRecords, params.maxAgeMinutes);
				if (isControlAction(action)) {
					const control = createControlEntry(capture, action, now(), {
						maxRecords: params.maxRecords,
						maxAgeMinutes: params.maxAgeMinutes,
					});
					pi.appendEntry(CONTROL_ENTRY_TYPE, control);
				}
				pruneCaptureState(capture, now());
				recordRuntime(ctx, "diagnostic_tool", false);
				const response = createDiagnosticResponse({
					action,
					detail: params.detail ?? "summary",
					sections: params.sections ?? [],
					limit: params.limit ?? 10,
					pi,
					ctx,
					capture,
					capturedAt: now(),
				});
				const bounded = boundDiagnosticResponse(response);
				return {
					content: [{ type: "text", text: bounded.text }],
					details: bounded.value,
				};
			},
		});

		pi.registerCommand(COMMAND_NAME, {
			description: "Show a concise privacy-filtered runtime diagnostic summary",
			getArgumentCompletions(prefix) {
				const normalized = prefix.trimStart();
				if (normalized.includes(" ")) return null;
				const matches = COMMAND_ROUTES.filter((route) => route.startsWith(normalized)).map(
					(route) => ({ value: route, label: route }),
				);
				return matches.length > 0 ? matches : null;
			},
			async handler(args, ctx) {
				if (!ctx.hasUI) {
					throw new Error(
						`/${COMMAND_NAME} supports TUI and RPC modes only; use the ${TOOL_NAME} tool for machine-readable diagnostics.`,
					);
				}
				const route = parseCommandRoute(args);
				const sections: DiagnosticSection[] =
					route === "provider" ||
					route === "cache" ||
					route === "tools" ||
					route === "extensions" ||
					route === "privacy"
						? [route]
						: [];
				pruneCaptureState(capture, now());
				const response = createDiagnosticResponse({
					action: "status",
					detail: "summary",
					sections,
					limit: 5,
					pi,
					ctx,
					capture,
					capturedAt: now(),
				});
				ctx.ui.notify(formatCommandSummary(response, route), "info");
			},
		});

		pi.on("session_start", (_event, ctx) => {
			restoreBranchState(ctx, "session_start");
		});

		pi.on("session_tree", (_event, ctx) => {
			restoreBranchState(ctx, "session_tree");
		});

		pi.on("model_select", (_event, ctx) => {
			recordRuntime(ctx, "model_select", false);
		});

		pi.on("before_agent_start", (_event, ctx) => {
			recordRuntime(ctx, "before_agent_start", false);
		});

		pi.on("tool_execution_end", (_event, ctx) => {
			recordRuntime(ctx, "tools_changed", false);
		});

		pi.on("agent_end", () => {
			finalizePendingRequests(capture);
		});

		pi.on("message_end", (event, ctx) => {
			if (event.message.role !== "assistant") return;
			const snapshot = createRuntimeSnapshot(pi, ctx, "assistant_message", now(), {
				provider: event.message.provider,
				model: event.message.model,
				usage: event.message.usage,
			});
			lastRuntimeSignature = runtimeStateSignature(snapshot);
			pi.appendEntry(RUNTIME_ENTRY_TYPE, snapshot);
		});

		pi.on("before_provider_request", (event, ctx) => {
			if (!capture.enabled) return;
			const diagnostic = extractProviderRequestDiagnostic(event.payload, {
				requestIndex: capture.nextRequestIndex,
				capturedAt: now(),
				sessionId: ctx.sessionManager.getSessionId(),
				provider: ctx.model?.provider,
				model: ctx.model?.id,
				api: ctx.model?.api,
			});
			capture.nextRequestIndex += 1;
			capture.records.push(diagnostic);
			if (diagnostic.responseTelemetry === "pending") {
				capture.pendingRequestIndexes.push(diagnostic.requestIndex);
			}
			pruneCaptureState(capture, now());
			pi.appendEntry(PROVIDER_REQUEST_ENTRY_TYPE, diagnostic);
		});

		pi.on("after_provider_response", (event) => {
			const requestIndex = capture.pendingRequestIndexes[0];
			if (requestIndex === undefined) return;
			const request = capture.records.find((record) => record.requestIndex === requestIndex);
			if (!request) return;
			const response = createProviderResponseDiagnostic(request, event.status, now());
			attachProviderResponse(request, response);
			pi.appendEntry(PROVIDER_RESPONSE_ENTRY_TYPE, response);
			if (event.status >= 200 && event.status < 300) {
				capture.pendingRequestIndexes.shift();
			}
		});

		function restoreBranchState(
			ctx: ExtensionContext,
			reason: "session_start" | "session_tree",
		): void {
			capture = restoreCaptureState(ctx.sessionManager.getBranch(), now());
			lastRuntimeSignature = undefined;
			recordRuntime(ctx, reason, true);
		}

		function recordRuntime(
			ctx: ExtensionContext,
			reason: RuntimeSnapshotReason,
			force: boolean,
		): void {
			const snapshot = createRuntimeSnapshot(pi, ctx, reason, now());
			const signature = runtimeStateSignature(snapshot);
			if (!force && signature === lastRuntimeSignature) return;
			lastRuntimeSignature = signature;
			pi.appendEntry(RUNTIME_ENTRY_TYPE, snapshot);
		}
	};
}

function isControlAction(action: DiagnosticAction): action is CaptureControlAction {
	return (
		action === "enable" || action === "disable" || action === "clear" || action === "configure"
	);
}

function validateRetentionParameters(
	action: DiagnosticAction,
	maxRecords: number | undefined,
	maxAgeMinutes: number | undefined,
): void {
	const hasPolicy = maxRecords !== undefined || maxAgeMinutes !== undefined;
	if (action === "configure" && !hasPolicy) {
		throw new Error("runtime_diagnostics configure requires maxRecords or maxAgeMinutes.");
	}
	if (action !== "configure" && hasPolicy) {
		throw new Error(
			"runtime_diagnostics maxRecords and maxAgeMinutes are accepted only with action configure.",
		);
	}
}

function parseCommandRoute(args: string): CommandRoute {
	const normalized = args.trim();
	if (!normalized) return "status";
	const parts = normalized.split(/\s+/);
	if (parts.length !== 1 || !COMMAND_ROUTES.includes(parts[0] as CommandRoute)) {
		throw new Error(
			`Unknown /${COMMAND_NAME} route. Expected one of: ${COMMAND_ROUTES.join(", ")}.`,
		);
	}
	return parts[0] as CommandRoute;
}

export default createDebugExtension();
