import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createImplementationPreferenceChange,
	hasImplementationPreferences,
	type ImplementationSnapshot,
	preferenceError,
	preflightImplementationPreferences,
	sameModel,
} from "./implementation-preferences.js";
import { type ImplementationPreferences, normalizePlanModeSettings } from "./settings.js";

export const FRESH_PREFERENCES_ENTRY = "plan-mode:fresh-preferences:v1";

export interface FreshPreferencesRequest {
	id: string;
	status: "pending";
	preferences: ImplementationPreferences;
}

/** Called only for reason=new, with the destination instance's own API. */
export async function applyFreshImplementationPreferences(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	isCurrent: () => boolean,
	selectionSnapshot?: () => ImplementationSnapshot | undefined,
	isSessionCurrent: () => boolean = isCurrent,
	beginPreferenceApplication?: () => () => void,
) {
	if (!isCurrent() || !ctx.isIdle()) return;
	const entry = latestPreferenceEntry(ctx);
	if (entry?.type !== "custom" || !entry.data || typeof entry.data !== "object") return;
	const request = entry.data as Partial<FreshPreferencesRequest>;
	if (request.status !== "pending" || typeof request.id !== "string") return;
	const preferences = normalizePlanModeSettings(request.preferences);
	// Consume before any await. Reload/resume never replays a handoff selection.
	pi.appendEntry(FRESH_PREFERENCES_ENTRY, { id: request.id, status: "failed" });
	if (!preferences || !hasImplementationPreferences(preferences)) return;
	const change = createImplementationPreferenceChange(
		pi,
		ctx,
		isSessionCurrent,
		undefined,
		selectionSnapshot,
	);
	let finishPreferenceApplication: (() => void) | undefined;
	try {
		const originalModel = ctx.model;
		const originalThinking = pi.getThinkingLevel();
		const current = () => isCurrent() && ctx.isIdle();
		const model = await preflightImplementationPreferences(
			ctx,
			preferences,
			() =>
				current() &&
				sameModel(ctx.model, originalModel) &&
				pi.getThinkingLevel() === originalThinking,
		);
		if (!model || !current()) return;
		finishPreferenceApplication = beginPreferenceApplication?.();
		if (!(await change.apply(model, preferences, current)) || !current()) {
			await change.rollback();
			return;
		}
		pi.appendEntry(FRESH_PREFERENCES_ENTRY, {
			id: request.id,
			status: "applied",
			model: { provider: ctx.model?.provider, id: ctx.model?.id },
			thinking: pi.getThinkingLevel(),
		});
	} catch (error) {
		await change.rollback().catch(() => undefined);
		if (!isCurrent()) return;
		pi.appendEntry(FRESH_PREFERENCES_ENTRY, {
			id: request.id,
			status: "failed",
			error: preferenceError(error),
		});
	} finally {
		finishPreferenceApplication?.();
	}
}

/** No captured source API is usable here; inspect only the replacement context. */
function latestPreferenceEntry(ctx: ExtensionContext) {
	return ctx.sessionManager
		.getBranch()
		.slice()
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === FRESH_PREFERENCES_ENTRY);
}

export function freshPreferencesApplied(ctx: ExtensionContext, id: string) {
	const entry = latestPreferenceEntry(ctx);
	if (entry?.type !== "custom" || !entry.data || typeof entry.data !== "object") return false;
	const result = entry.data as {
		id?: string;
		status?: string;
		model?: { provider: string; id: string };
		thinking?: string;
	};
	return (
		result.id === id &&
		result.status === "applied" &&
		sameModel(ctx.model, result.model) &&
		ctx.thinkingLevel === result.thinking
	);
}
