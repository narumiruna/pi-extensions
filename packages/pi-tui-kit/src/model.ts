import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type ActionMenuItem,
  MAX_REVIEW_VIEWPORT_SIZE,
  type MenuContext,
  type MenuDefinition,
  type MenuScreen,
} from "./types.js";

export function defineMenu<
  State,
  ScreenId extends string,
  ActionId extends string,
  Context extends MenuContext = ExtensionCommandContext,
>(definition: MenuDefinition<State, ScreenId, ActionId, Context>): MenuDefinition<State, ScreenId, ActionId, Context> {
  if (!hasOwn(definition.screens, definition.start)) {
    throw new Error(`Menu starts at unknown screen: ${definition.start}`);
  }
  return definition;
}

export function resolveMenuScreen<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  screenId: ScreenId,
  state: State,
): MenuScreen<ScreenId, ActionId> {
  const factory = definition.screens[screenId];
  if (!factory) throw new Error(`Menu requested unknown screen: ${screenId}`);
  const screen = factory({ state });
  validateScreen(definition, screen);
  return screen;
}

function validateScreen<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
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
  if (screen.kind === "browse") {
    if (
      screen.viewportSize !== undefined &&
      screen.viewportSize !== "adaptive" &&
      (!Number.isInteger(screen.viewportSize) || screen.viewportSize <= 0)
    ) {
      throw new Error('Menu browse viewport size must be "adaptive" or a positive integer');
    }
    return;
  }
  if (screen.kind === "choice") {
    assertAction(definition, `choice screen ${screen.title}`, screen.action);
    if (screen.viewportSize !== undefined && (!Number.isInteger(screen.viewportSize) || screen.viewportSize <= 0)) {
      throw new Error("Menu choice viewport size must be a positive integer");
    }
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
  if (screen.kind === "input") {
    assertAction(definition, `input screen ${screen.title}`, screen.action);
    return;
  }
  if (screen.kind === "review") {
    if (
      screen.viewportSize !== undefined &&
      screen.viewportSize !== "adaptive" &&
      (!Number.isInteger(screen.viewportSize) ||
        screen.viewportSize <= 0 ||
        screen.viewportSize > MAX_REVIEW_VIEWPORT_SIZE)
    ) {
      throw new Error(
        `Menu review viewport size must be "adaptive" or a positive integer no greater than ${MAX_REVIEW_VIEWPORT_SIZE}`,
      );
    }
    if (screen.confirm) {
      if (!screen.confirm.id.trim()) {
        throw new Error("Menu review confirmation id must not be empty");
      }
      if (!screen.confirm.label.trim()) {
        throw new Error("Menu review confirmation label must not be empty");
      }
      assertAction(definition, `review screen ${screen.title}`, screen.confirm.action);
    }
    return;
  }
  if (screen.kind === "multiSelect") {
    assertAction(definition, screen.title, screen.action);
    if (screen.viewportSize !== undefined && (!Number.isInteger(screen.viewportSize) || screen.viewportSize <= 0)) {
      throw new Error("Menu multi-select viewport size must be a positive integer");
    }
    for (const item of screen.actions ?? []) validateActionItem(definition, item);
  }
}

function validateActionItem<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
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

function assertAction<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
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
