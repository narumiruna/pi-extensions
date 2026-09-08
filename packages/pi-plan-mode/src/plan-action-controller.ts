import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanExportDestination } from "./plan-export.js";
import type { ImplementationPreferences } from "./settings.js";
import type { PlanModeState } from "./state.js";

type InteractiveUi = typeof import("./interactive-ui.js");

interface MenuLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
}

interface PlanActionControllerOptions {
	loadInteractiveUi(): Promise<InteractiveUi>;
	getState(): PlanModeState;
	captureLifecycle(): MenuLifecycle;
	statusText(): string;
	implementationOutcome(): string;
	getExportDestination(ctx: ExtensionContext): PlanExportDestination;
	show(ctx: ExtensionContext): void;
	finalize(ctx: ExtensionContext): void;
	getImplementationPreferences?(): ImplementationPreferences;
	implementHere(
		ctx: ExtensionContext,
		preferences?: ImplementationPreferences,
		isCurrent?: () => boolean,
	): void | Promise<void>;
	implementFresh(
		ctx: ExtensionContext,
		isCurrent: () => boolean,
		preferences?: ImplementationPreferences,
	): void | Promise<void>;
	exportPlan(
		ctx: ExtensionContext,
		path: string,
		signal: AbortSignal,
		isCurrent: () => boolean,
	): Promise<boolean>;
	settings(ctx: ExtensionContext, signal: AbortSignal, isCurrent: () => boolean): Promise<boolean>;
	save(ctx: ExtensionContext): void;
	stay(ctx: ExtensionContext): void;
	exitReady(ctx: ExtensionContext): void;
	clearSaved(ctx: ExtensionContext): void;
}

export function createPlanActionController(options: PlanActionControllerOptions) {
	const implementationActions = (ctx: ExtensionContext, lifecycle: MenuLifecycle) => ({
		implementationPreferences: options.getImplementationPreferences?.(),
		implementHere: (preferences?: ImplementationPreferences, signal?: AbortSignal) =>
			options.implementHere(
				ctx,
				preferences,
				() => lifecycle.isCurrent() && !lifecycle.signal.aborted && !signal?.aborted,
			),
		implementFresh: (signal: AbortSignal, preferences?: ImplementationPreferences) =>
			options.implementFresh(ctx, () => lifecycle.isCurrent() && !signal.aborted, preferences),
	});

	return {
		async showSaved(ctx: ExtensionContext) {
			const lifecycle = options.captureLifecycle();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			const ui = await options.loadInteractiveUi();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			await ui.showSavedPlanMenu(ctx, {
				statusText: options.statusText(),
				implementationOutcome: options.implementationOutcome,
				getExportDestination: () => options.getExportDestination(ctx),
				signal: lifecycle.signal,
				isCurrent: lifecycle.isCurrent,
				show: () => options.show(ctx),
				...implementationActions(ctx, lifecycle),
				exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
				settings: (signal) => options.settings(ctx, signal, lifecycle.isCurrent),
				clear: () => options.clearSaved(ctx),
			});
		},
		async showCurrent(ctx: ExtensionContext) {
			if (!ctx.hasUI) {
				ctx.ui.notify(options.statusText(), "info");
				return;
			}
			const lifecycle = options.captureLifecycle();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			const ui = await options.loadInteractiveUi();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			await ui.showPlanModeMenu(ctx, {
				statusText: options.statusText(),
				hasReadyPlan: options.getState().latestPlan !== undefined,
				implementationOutcome: options.implementationOutcome,
				getExportDestination: () => options.getExportDestination(ctx),
				...lifecycle,
				show: () => options.show(ctx),
				finalize: () => options.finalize(ctx),
				...implementationActions(ctx, lifecycle),
				exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
				save: () => options.save(ctx),
				stay: () => options.stay(ctx),
				exit: () => options.exitReady(ctx),
			});
		},
		async showReady(ctx: ExtensionContext) {
			const lifecycle = options.captureLifecycle();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			const ui = await options.loadInteractiveUi();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			await ui.showReadyPlanMenu(ctx, {
				...lifecycle,
				implementationOutcome: options.implementationOutcome,
				getExportDestination: () => options.getExportDestination(ctx),
				...implementationActions(ctx, lifecycle),
				exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
				save: () => options.save(ctx),
				stay: () => undefined,
				exit: () => options.exitReady(ctx),
			});
		},
	};
}
