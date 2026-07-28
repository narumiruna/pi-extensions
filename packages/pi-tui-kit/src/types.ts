import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type MenuTransition<ScreenId extends string> =
	| { kind: "stay" }
	| { kind: "back" }
	| { kind: "close" }
	| { kind: "to"; screen: ScreenId };

export type MenuActionResult<ScreenId extends string> =
	| MenuTransition<ScreenId>
	| { kind: "rejected"; error?: unknown }
	| undefined;

export interface MenuActionContext<State> {
	ctx: ExtensionCommandContext;
	state: State;
	signal: AbortSignal;
	itemId: string;
	value?: string;
	selected?: boolean;
}

export type MenuActionHandler<State, ScreenId extends string> = (
	context: MenuActionContext<State>,
) => MenuActionResult<ScreenId> | Promise<MenuActionResult<ScreenId>>;

interface MenuItemBase {
	id: string;
	label: string;
	description?: string;
	disabled?: boolean;
}

export type ActionMenuItem<ScreenId extends string, ActionId extends string> =
	| (MenuItemBase & { to: ScreenId; action?: never; close?: never })
	| (MenuItemBase & { action: ActionId; to?: never; close?: never; busyLabel?: string })
	| (MenuItemBase & { close: true; to?: never; action?: never });

export interface ActionsScreen<ScreenId extends string, ActionId extends string> {
	kind: "actions";
	title: string;
	lines?: readonly string[];
	items: readonly ActionMenuItem<ScreenId, ActionId>[];
	hint?: "back" | "close";
}

export interface DetailScreen {
	kind: "detail";
	title: string;
	lines: readonly string[];
	hint?: "back" | "close";
}

export interface MenuSettingItem<ActionId extends string> extends MenuItemBase {
	currentValue: string;
	values?: readonly string[];
	action: ActionId;
}

export interface SettingsScreen<ActionId extends string> {
	kind: "settings";
	title: string;
	lines?: readonly string[];
	items: readonly MenuSettingItem<ActionId>[];
}

export interface MenuMultiSelectItem extends MenuItemBase {
	selected: boolean;
}

export interface MultiSelectScreen<ScreenId extends string, ActionId extends string> {
	kind: "multiSelect";
	title: string;
	lines?: readonly string[];
	items: readonly MenuMultiSelectItem[];
	action: ActionId;
	actions?: readonly ActionMenuItem<ScreenId, ActionId>[];
	hint?: "back" | "close";
	doneLabel?: string;
}

export type MenuScreen<ScreenId extends string, ActionId extends string> =
	| ActionsScreen<ScreenId, ActionId>
	| DetailScreen
	| SettingsScreen<ActionId>
	| MultiSelectScreen<ScreenId, ActionId>;

export interface MenuScreenContext<State> {
	state: State;
}

export type MenuScreenFactory<State, ScreenId extends string, ActionId extends string> = (
	context: MenuScreenContext<State>,
) => MenuScreen<ScreenId, ActionId>;

export interface MenuDefinition<State, ScreenId extends string, ActionId extends string> {
	start: ScreenId;
	screens: Record<ScreenId, MenuScreenFactory<State, ScreenId, ActionId>>;
	actions: Record<ActionId, MenuActionHandler<State, ScreenId>>;
}
