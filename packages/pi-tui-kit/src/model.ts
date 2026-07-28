import type { ActionMenuItem, MenuDefinition, MenuScreen } from "./types.js";

export function defineMenu<State, ScreenId extends string, ActionId extends string>(
	definition: MenuDefinition<State, ScreenId, ActionId>,
): MenuDefinition<State, ScreenId, ActionId> {
	if (!hasOwn(definition.screens, definition.start)) {
		throw new Error(`Menu starts at unknown screen: ${definition.start}`);
	}
	return definition;
}

export function resolveMenuScreen<State, ScreenId extends string, ActionId extends string>(
	definition: MenuDefinition<State, ScreenId, ActionId>,
	screenId: ScreenId,
	state: State,
): MenuScreen<ScreenId, ActionId> {
	const factory = definition.screens[screenId];
	if (!factory) throw new Error(`Menu requested unknown screen: ${screenId}`);
	const screen = factory({ state });
	validateScreen(definition, screen);
	return screen;
}

function validateScreen<State, ScreenId extends string, ActionId extends string>(
	definition: MenuDefinition<State, ScreenId, ActionId>,
	screen: MenuScreen<ScreenId, ActionId>,
) {
	if (!screen.title.trim()) throw new Error("Menu screen title must not be empty");
	const ids = new Set<string>();
	const actionItems = screen.kind === "multiSelect" ? (screen.actions ?? []) : [];
	for (const item of [...("items" in screen ? screen.items : []), ...actionItems]) {
		if (!item.id.trim()) throw new Error("Menu item id must not be empty");
		if (ids.has(item.id)) throw new Error(`Menu item id must be unique: ${item.id}`);
		ids.add(item.id);
	}

	if (screen.kind === "actions") {
		for (const item of screen.items) validateActionItem(definition, item);
		return;
	}
	if (screen.kind === "settings") {
		for (const item of screen.items) {
			assertAction(definition, item.id, item.action);
			if (item.values && item.values.length === 0) {
				throw new Error(`Menu setting ${item.id} must define at least one value`);
			}
			if (item.values && !item.values.includes(item.currentValue)) {
				throw new Error(`Menu setting ${item.id} values must include its current value`);
			}
		}
		return;
	}
	if (screen.kind === "multiSelect") {
		assertAction(definition, screen.title, screen.action);
		for (const item of screen.actions ?? []) validateActionItem(definition, item);
	}
}

function validateActionItem<State, ScreenId extends string, ActionId extends string>(
	definition: MenuDefinition<State, ScreenId, ActionId>,
	item: ActionMenuItem<ScreenId, ActionId>,
) {
	const targetCount = Number("to" in item) + Number("action" in item) + Number("close" in item);
	if (targetCount !== 1) {
		throw new Error(`Menu action item must have exactly one target: ${item.id}`);
	}
	if ("to" in item && item.to !== undefined && !hasOwn(definition.screens, item.to)) {
		throw new Error(`Menu item ${item.id} references unknown screen: ${item.to}`);
	}
	if ("action" in item && item.action !== undefined && !hasOwn(definition.actions, item.action)) {
		throw new Error(`Menu item ${item.id} references unknown action: ${item.action}`);
	}
}

function assertAction<State, ScreenId extends string, ActionId extends string>(
	definition: MenuDefinition<State, ScreenId, ActionId>,
	owner: string,
	action: ActionId,
) {
	if (!hasOwn(definition.actions, action)) {
		throw new Error(`Menu item ${owner} references unknown action: ${action}`);
	}
}

function hasOwn(value: object, key: PropertyKey) {
	return Object.hasOwn(value, key);
}
