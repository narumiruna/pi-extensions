import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition } from "@narumitw/pi-tui-kit";
import { isCodexProvider } from "./checkpoint.js";
import type {
	CodexCompactSettings,
	CodexCompactSettingsRuntime,
	CodexCompactSettingsState,
} from "./settings.js";

type Screen = "main" | "settings" | "invalid";
type Action =
	| "compact-now"
	| "set-enabled"
	| "set-timeout"
	| "set-retries"
	| "set-retention"
	| "set-notify";

export interface SettingsMenuOwner {
	signal: AbortSignal;
	isCurrent(): boolean;
}

interface CompactMenuStatus {
	model: string;
	remoteCompatible: boolean;
}

function safeText(value: string): string {
	return Array.from(value, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
	}).join("");
}

function timeoutLabel(milliseconds: number): string {
	return `${milliseconds / 60_000} min`;
}

function retentionLabel(tokens: number): string {
	return `${tokens / 1000}K tokens`;
}

async function update(
	runtime: CodexCompactSettingsRuntime,
	ctx: ExtensionCommandContext,
	patch: Partial<CodexCompactSettings>,
	signal: AbortSignal,
) {
	try {
		await runtime.update(patch, signal);
		ctx.ui.notify("Codex compaction settings saved.", "info");
		return { kind: "stay" as const };
	} catch (error) {
		if (signal.aborted) return { kind: "rejected" as const };
		ctx.ui.notify(
			`Could not save pi-codex-compact.json: ${safeText(error instanceof Error ? error.message : String(error))}`,
			"error",
		);
		return { kind: "rejected" as const };
	}
}

export function createCodexCompactMenu(
	runtime: CodexCompactSettingsRuntime,
	options: { onCompactRequested?: () => void; status?: CompactMenuStatus } = {},
): MenuDefinition<CodexCompactSettingsState, Screen, Action, ExtensionCommandContext> {
	return {
		start: "main",
		screens: {
			main: ({ state }) => ({
				kind: "actions",
				title: "Codex Remote Compaction",
				lines: [
					`Remote V2: ${state.settings.enabled ? "On" : "Off"}`,
					`Active model: ${safeText(options.status?.model ?? "none")}`,
					`Compact route: ${safeText(compactRoute(state, options.status))}`,
				],
				items: [
					{
						id: "compact-now",
						label: "Compact now",
						description: "Close this menu and compact the active session immediately.",
						action: "compact-now",
					},
					state.kind === "invalid"
						? {
								id: "settings",
								label: "Settings",
								description: "Read-only until the invalid settings file is repaired.",
								to: "invalid" as const,
							}
						: { id: "settings", label: "Settings", to: "settings" as const },
					{ id: "close", label: "Close", close: true },
				],
				hint: "close",
			}),
			settings: ({ state }) => ({
				kind: "settings",
				title: "Codex Remote Compaction Settings",
				lines: [`User settings · ${safeText(state.path)}`],
				items: [
					{
						id: "enabled",
						label: "Remote compaction",
						description: "Use Codex Remote V2 when the active model is compatible.",
						currentValue: state.settings.enabled ? "On" : "Off",
						values: ["On", "Off"],
						action: "set-enabled",
					},
					{
						id: "requestTimeoutMs",
						label: "Request timeout",
						description: "Maximum time for the extension-owned remote compaction request.",
						currentValue: timeoutLabel(state.settings.requestTimeoutMs),
						values: ["2 min", "5 min", "10 min"],
						action: "set-timeout",
					},
					{
						id: "maxRetries",
						label: "Transport retries",
						description: "Retry transient provider failures before falling back to Pi.",
						currentValue: String(state.settings.maxRetries),
						values: ["0", "1", "2"],
						action: "set-retries",
					},
					{
						id: "replacementTokenBudget",
						label: "Retained user history",
						description: "Approximate user-message budget kept beside the opaque checkpoint.",
						currentValue: retentionLabel(state.settings.replacementTokenBudget),
						values: ["32K tokens", "64K tokens", "96K tokens", "128K tokens"],
						action: "set-retention",
					},
					{
						id: "notifyOnFallback",
						label: "Fallback notifications",
						description: "Warn when Remote V2 fails and native Pi compaction takes over.",
						currentValue: state.settings.notifyOnFallback ? "On" : "Off",
						values: ["On", "Off"],
						action: "set-notify",
					},
				],
			}),
			invalid: ({ state }) => ({
				kind: "detail",
				title: "Codex Compact Settings · Read only",
				lines: [
					`Invalid settings file: ${safeText(state.path)}`,
					`Issue: ${safeText(state.issue ?? "unknown validation error")}`,
					"Built-in defaults are active. Repair the file and run /reload; it will not be overwritten.",
				],
				hint: "back",
			}),
		},
		actions: {
			"compact-now": async () => {
				options.onCompactRequested?.();
				return { kind: "close" };
			},
			"set-enabled": ({ ctx, value, signal }) =>
				update(runtime, ctx, { enabled: value === "On" }, signal),
			"set-timeout": ({ ctx, value, signal }) =>
				update(
					runtime,
					ctx,
					{ requestTimeoutMs: Number.parseInt(value ?? "5", 10) * 60_000 },
					signal,
				),
			"set-retries": ({ ctx, value, signal }) =>
				update(runtime, ctx, { maxRetries: Number.parseInt(value ?? "2", 10) }, signal),
			"set-retention": ({ ctx, value, signal }) =>
				update(
					runtime,
					ctx,
					{ replacementTokenBudget: Number.parseInt(value ?? "64", 10) * 1000 },
					signal,
				),
			"set-notify": ({ ctx, value, signal }) =>
				update(runtime, ctx, { notifyOnFallback: value === "On" }, signal),
		},
	};
}

export async function showCodexCompactMenu(
	runtime: CodexCompactSettingsRuntime,
	ctx: ExtensionCommandContext,
	owner: SettingsMenuOwner,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Edit Codex compaction settings at ${safeText(runtime.get().path)}.`, "info");
		return;
	}
	const { runMenu } = await import("@narumitw/pi-tui-kit");
	if (owner.signal.aborted || !owner.isCurrent()) return;
	let compactRequested = false;
	await runMenu(
		ctx,
		createCodexCompactMenu(runtime, {
			onCompactRequested: () => {
				compactRequested = true;
			},
			status: compactMenuStatus(ctx),
		}),
		{
			getState: () => runtime.get(),
			signal: owner.signal,
			isCurrent: owner.isCurrent,
		},
	);
	if (!compactRequested || owner.signal.aborted || !owner.isCurrent()) return;
	ctx.compact({
		onError: (error) => {
			if (!owner.signal.aborted && owner.isCurrent()) {
				ctx.ui.notify(`Compaction failed: ${safeText(error.message)}`, "error");
			}
		},
	});
}

function compactMenuStatus(ctx: ExtensionCommandContext): CompactMenuStatus {
	const model = ctx.model;
	return {
		model: model ? `${model.provider}/${model.id}` : "none",
		remoteCompatible: isCodexProvider(model?.provider) && model.api === "openai-codex-responses",
	};
}

function compactRoute(
	state: Readonly<CodexCompactSettingsState>,
	status: CompactMenuStatus | undefined,
): string {
	if (!state.settings.enabled) return "Pi native (Remote V2 off)";
	return status?.remoteCompatible ? "Codex Remote V2" : "Pi native (model not compatible)";
}
