import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImplementationPreferences } from "./settings.js";

type Model = NonNullable<ExtensionContext["model"]>;
type Thinking = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export interface ImplementationSnapshot {
	model: Model | undefined;
	thinking: Thinking;
}

export function observeImplementationModelSelections(pi: ExtensionAPI) {
	let latest: ImplementationSnapshot | undefined;
	pi.on("model_select", (_event, ctx) => {
		latest = { model: ctx.model, thinking: pi.getThinkingLevel() };
	});
	return () => latest;
}

export function hasImplementationPreferences(preferences: ImplementationPreferences) {
	return (
		preferences.implementationModel !== undefined ||
		(preferences.implementationThinkingLevel !== undefined &&
			preferences.implementationThinkingLevel !== "inherit")
	);
}

export function sameModel(
	left: { provider: string; id: string } | undefined,
	right: { provider: string; id: string } | undefined,
) {
	return left?.provider === right?.provider && left?.id === right?.id;
}

export function safeImplementationText(value: string) {
	return [...value]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
		})
		.join("")
		.trim();
}

export function preferenceError(error: unknown) {
	return safeImplementationText(error instanceof Error ? error.message : String(error)).slice(
		0,
		500,
	);
}

export async function preflightImplementationPreferences(
	ctx: ExtensionContext,
	preferences: ImplementationPreferences,
	isCurrent: () => boolean,
): Promise<Model | undefined> {
	if (!isCurrent()) return undefined;
	const identity = preferences.implementationModel;
	const model = identity ? ctx.modelRegistry.find(identity.provider, identity.id) : ctx.model;
	if (!model)
		throw new Error(
			"Implementation model is unavailable. Select a registered model or use current.",
		);
	// Pi's auth facade has no AbortSignal. Pi owns this operation; drain it and
	// revalidate rather than claiming that cancellation stops provider auth work.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!isCurrent()) return undefined;
	// Composed registries may materialize a new definition on every lookup.
	const currentModel = identity ? ctx.modelRegistry.find(identity.provider, identity.id) : model;
	if (!currentModel) {
		throw new Error(
			"Implementation model catalogue changed during preflight. Reopen the menu and retry.",
		);
	}
	if (!auth.ok) throw new Error(auth.error);
	return currentModel;
}

/** A one-shot handoff transaction, never an implementation-run restoration hook. */
export function createImplementationPreferenceChange(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	isSessionCurrent: () => boolean,
	original: ImplementationSnapshot = { model: ctx.model, thinking: pi.getThinkingLevel() },
	selectionSnapshot?: () => ImplementationSnapshot | undefined,
) {
	let applied: ImplementationSnapshot | undefined;
	const snapshot = (): ImplementationSnapshot => ({
		model: ctx.model,
		thinking: pi.getThinkingLevel(),
	});
	const matches = (value: ImplementationSnapshot) =>
		sameModel(ctx.model, value.model) && pi.getThinkingLevel() === value.thinking;
	return {
		async apply(model: Model, preferences: ImplementationPreferences, isCurrent: () => boolean) {
			if (!isCurrent()) return false;
			// Includes any Plan-thinking restoration performed immediately before apply.
			applied = snapshot();
			if (preferences.implementationModel && !sameModel(ctx.model, model)) {
				const beforeSelection = selectionSnapshot?.();
				if (!(await pi.setModel(model)))
					throw new Error("Implementation model authentication is unavailable.");
				if (!isSessionCurrent()) return false;
				if (!sameModel(ctx.model, model)) return false;
				const selected = selectionSnapshot?.();
				applied = selected && selected !== beforeSelection ? selected : snapshot();
				if (!matches(applied)) {
					if (ctx.hasUI)
						ctx.ui.notify(
							"Model or thinking changed during implementation preparation. The plan remains available; retry when ready.",
							"warning",
						);
					return false;
				}
				if (!isCurrent()) return false;
			}
			const level = preferences.implementationThinkingLevel;
			if (level && level !== "inherit") {
				pi.setThinkingLevel(level);
				applied = snapshot();
				if (applied.thinking !== level && ctx.hasUI)
					ctx.ui.notify(
						`Implementation thinking: ${applied.thinking} (requested ${level}; adjusted by Pi for this model).`,
						"info",
					);
			}
			return isCurrent();
		},
		async rollback() {
			if (!applied || !isSessionCurrent() || !ctx.isIdle() || !matches(applied)) return;
			if (!sameModel(ctx.model, original.model)) {
				const beforeSelection = selectionSnapshot?.();
				if (!original.model || !(await pi.setModel(original.model))) {
					throw new Error(
						"Could not restore the previous model. The plan remains available; select a model before retrying.",
					);
				}
				if (!isSessionCurrent() || !ctx.isIdle() || !sameModel(ctx.model, original.model)) return;
				const selected = selectionSnapshot?.();
				if (selected && selected !== beforeSelection && !matches(selected)) return;
			}
			pi.setThinkingLevel(original.thinking);
			applied = undefined;
		},
	};
}
