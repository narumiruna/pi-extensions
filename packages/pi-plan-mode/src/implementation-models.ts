import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH = 512;

export interface ImplementationModelOverride {
	provider: string;
	modelId: string;
}

export interface AvailableImplementationModel {
	provider: string;
	id: string;
	name?: string;
}

export function isPendingImplementationModelIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH
	);
}

export function snapshotAvailableImplementationModels(
	ctx: ExtensionContext,
): AvailableImplementationModel[] {
	const getAvailable = ctx.modelRegistry.getAvailable;
	const availableModels =
		typeof getAvailable === "function" ? getAvailable.call(ctx.modelRegistry) : [];
	const scopedModels = ctx.scopedModels ?? [];
	if (scopedModels.length === 0) return availableModels;
	return scopedModels.flatMap((entry) => {
		const availableModel = availableModels.find(
			(model) => model.provider === entry.model.provider && model.id === entry.model.id,
		);
		return availableModel ? [availableModel] : [];
	});
}

export function findAvailableImplementationModel(
	models: readonly AvailableImplementationModel[],
	configured: ImplementationModelOverride | undefined,
): AvailableImplementationModel | undefined {
	if (!configured) return undefined;
	return models.find(
		(model) => model.provider === configured.provider && model.id === configured.modelId,
	);
}
