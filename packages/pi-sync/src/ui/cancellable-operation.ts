import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatInteractionHints, runCustomInteraction } from "@narumitw/pi-tui-kit";
import type { SetupPullOutcome } from "../sync/setup-switch.js";
import type { SyncDecision } from "../sync/sync-decision.js";
import type { RemoteSelectionDecision } from "../sync/sync-policy.js";

export type RunRouteResult =
	| { kind: "completed"; outcome?: SetupPullOutcome }
	| { kind: "decision-required"; decision: SyncDecision }
	| { kind: "remote-selection-required"; decision: RemoteSelectionDecision }
	| { kind: "failed" };

export type RunRoute = (
	route: string,
	signal?: AbortSignal,
	onCommit?: () => void,
	target?: string,
) => Promise<RunRouteResult | undefined>;

export type CancellableOperationResult =
	| RunRouteResult
	| { kind: "closed" }
	| { kind: "cancelled" };

interface CancellableOperationOptions {
	commitAware?: boolean;
	cancelledMessage?: string | null;
	target?: string;
	signal?: AbortSignal;
}

export async function runCancellableOperation(
	ctx: ExtensionContext,
	message: string,
	route: string,
	runRoute: RunRoute,
	options: CancellableOperationOptions = {},
): Promise<CancellableOperationResult> {
	const {
		commitAware = false,
		cancelledMessage = "Check cancelled; no settings or files were changed.",
		target,
		signal,
	} = options;
	if (ctx.mode !== "tui") {
		return (await runRoute(route, signal, undefined, target)) ?? { kind: "failed" };
	}
	let commitStarted = false;
	let routeResult: RunRouteResult | undefined;
	const interaction = await runCustomInteraction<
		{ cancelled?: boolean; error?: unknown },
		ExtensionContext
	>(ctx, {
		signal,
		isCurrent: () => !signal?.aborted,
		create: ({ tui, theme, keybindings, signal: interactionSignal, complete }) => {
			const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
			const cancelHint = formatInteractionHints(keybindings, [
				{
					keys: [
						...keybindings.getKeys("tui.select.cancel").filter((key) => !hasControlCharacter(key)),
						"ctrl+c",
					],
					label: "cancel",
				},
			]);
			const operation = runRoute(
				route,
				interactionSignal,
				commitAware ? () => (commitStarted = true) : undefined,
				target,
			).then(
				(result) => {
					routeResult = result;
					complete({});
				},
				(error: unknown) => complete({ error }),
			);
			return {
				render(width: number) {
					const safeWidth = Math.max(1, width);
					const lines = loader.render(safeWidth);
					const bottomBorder = lines.at(-1);
					return [
						...lines.slice(0, -1),
						truncateToWidth(theme.fg("dim", cancelHint), safeWidth, ""),
						...(bottomBorder === undefined ? [] : [bottomBorder]),
					];
				},
				invalidate: () => loader.invalidate(),
				handleInput(data: string) {
					if (!matchesKey(data, Key.ctrl("c")) && !keybindings.matches(data, "tui.select.cancel")) {
						return;
					}
					if (commitStarted) {
						ctx.ui.notify(
							"Applying or publishing has started and cannot be cancelled safely.",
							"warning",
						);
						return;
					}
					complete({ cancelled: true });
				},
				dispose: () => loader.dispose(),
				waitForPending: () => operation,
			};
		},
	});
	if (interaction.kind === "error") throw interaction.error;
	if (interaction.kind !== "completed") return { kind: "closed" };
	if (interaction.value.cancelled) {
		if (cancelledMessage) ctx.ui.notify(cancelledMessage, "info");
		return { kind: "cancelled" };
	}
	if (interaction.value.error) throw interaction.value.error;
	return routeResult ?? { kind: "failed" };
}

function hasControlCharacter(value: string) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Unsafe key labels must be omitted.
	return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
