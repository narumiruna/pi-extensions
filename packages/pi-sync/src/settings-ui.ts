import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import type { RunRoute } from "./cancellable-operation.js";
import { loadConfig, localConfigPath, updateLocalConfig } from "./config.js";
import { dispatchManagerResult } from "./manager-result-dispatcher.js";
import { updateSyncSetup } from "./settings-management.js";
import {
	SETUP_SWITCH_ACTION_OPTIONS,
	saveOnSwitch,
	setupSwitchActionFromLabel,
	setupSwitchActionLabel,
} from "./setup-switch.js";
import { safeTerminalText } from "./sync-format.js";

export type SyncSettingsRoute = RunRoute;

export async function showSyncSettings(
	ctx: ExtensionCommandContext,
	runRoute: SyncSettingsRoute,
	signal?: AbortSignal,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Edit pi-sync settings manually: ${safeTerminalText(localConfigPath())}`, "info");
		return;
	}
	const initial = await loadConfig();
	if (signal?.aborted) return;
	const setupName = initial.setupName;
	type Action = "automatic" | "skip-secret-scan" | "on-switch" | "include" | "remote-include";
	const menu = defineMenu<
		Awaited<ReturnType<typeof loadConfig>>,
		"settings",
		Action,
		ExtensionCommandContext
	>({
		start: "settings",
		screens: {
			settings: ({ state }) => ({
				kind: "settings",
				title: "Pi Sync Settings",
				lines: [
					`Sync setup: ${safeTerminalText(state.setupName)} · Storage connection: ${safeTerminalText(state.connectionName)}`,
				],
				items: [
					{
						id: "automatic",
						label: "Automatic sync",
						description: "Run conservative synchronization at session startup and shutdown.",
						currentValue: state.automatic ? "On" : "Off",
						values: ["On", "Off"],
						action: "automatic",
					},
					{
						id: "skipSecretScan",
						label: "Skip secret scan",
						description: "Allow pushes without checking managed local files for possible secrets.",
						currentValue: state.skipSecretScan ? "On" : "Off",
						values: ["On", "Off"],
						action: "skip-secret-scan",
					},
					{
						id: "onSwitch",
						label: "After switching setup",
						description:
							"Ask before a reviewed pull, start a reviewed pull, or switch without checking remote files.",
						currentValue: setupSwitchActionLabel(state.onSwitch),
						values: SETUP_SWITCH_ACTION_OPTIONS.map(({ label }) => label),
						action: "on-switch",
					},
					{
						id: "include",
						label: "Included content",
						description: `${state.include.length} selected path${state.include.length === 1 ? "" : "s"}. Opens the reviewed content-selection draft.`,
						currentValue: "Open editor",
						action: "include",
					},
					{
						id: "remoteInclude",
						label: "Compare synced content",
						description: "Review this device and remote content lists before choosing either one.",
						currentValue: "Review",
						action: "remote-include",
					},
				],
			}),
		},
		actions: {
			automatic: async ({ value, signal: actionSignal }) => {
				const automatic = value === "On";
				const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
				try {
					const latest = await loadConfig(setupName);
					if (mutationSignal.aborted) return { kind: "rejected" };
					if (latest.automatic === automatic) return { kind: "stay" };
					await updateSyncSetup(
						setupName,
						(setup) => ({ ...setup, sync: { ...setup.sync, automatic } }),
						{ signal: mutationSignal },
					);
					if (mutationSignal.aborted) return { kind: "rejected" };
					ctx.ui.notify(
						`Automatic sync ${automatic ? "enabled" : "disabled"} for “${safeTerminalText(setupName)}”.`,
						"info",
					);
					return { kind: "stay" };
				} catch (error) {
					if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
			"skip-secret-scan": async ({ value, signal: actionSignal }) => {
				const skipSecretScan = value === "On";
				const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
				try {
					const latest = await loadConfig(setupName);
					if (mutationSignal.aborted) return { kind: "rejected" };
					if (latest.skipSecretScan === skipSecretScan) return { kind: "stay" };
					await updateLocalConfig((settings) => ({ ...settings, skipSecretScan }), mutationSignal);
					if (mutationSignal.aborted) return { kind: "rejected" };
					ctx.ui.notify(
						`Secret scan ${skipSecretScan ? "disabled" : "enabled"} for pushes.`,
						"info",
					);
					return { kind: "stay" };
				} catch (error) {
					if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
			"on-switch": async ({ value, signal: actionSignal }) => {
				const action = value ? setupSwitchActionFromLabel(value) : undefined;
				if (!action) return { kind: "rejected" };
				const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
				try {
					const latest = await loadConfig(setupName);
					if (mutationSignal.aborted) return { kind: "rejected" };
					if (latest.onSwitch === action) return { kind: "stay" };
					await saveOnSwitch(action, mutationSignal);
					if (mutationSignal.aborted) return { kind: "rejected" };
					ctx.ui.notify(`After switching setup: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
			include: async ({ signal: actionSignal }) => {
				const editorSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
				await runRoute("files", editorSignal, undefined, setupName);
				return editorSignal.aborted ? { kind: "rejected" } : { kind: "stay" };
			},
			"remote-include": async ({ signal: actionSignal }) => {
				const reviewSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
				const { showRemoteSelectionReview } = await import("./remote-selection-ui.js");
				if (reviewSignal.aborted) return { kind: "rejected" };
				const review = await showRemoteSelectionReview(ctx, setupName, reviewSignal, undefined, {
					origin: "settings",
					runRoute,
				});
				if (reviewSignal.aborted) return { kind: "rejected" };
				if (review.kind === "route-result") {
					const disposition = await dispatchManagerResult(
						ctx,
						review.result,
						review.route,
						runRoute,
						reviewSignal,
					);
					return disposition.kind === "close" ? { kind: "close" } : { kind: "stay" };
				}
				return review.kind === "closed" || review.kind === "stale"
					? { kind: "close" }
					: { kind: "stay" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => loadConfig(setupName),
		signal,
		isCurrent: () => !signal?.aborted,
	});
}

function notifySaveFailure(ctx: ExtensionCommandContext, error: unknown) {
	ctx.ui.notify(
		`Pi Sync settings save failed: ${error instanceof Error ? error.message : String(error)}`,
		"error",
	);
}
