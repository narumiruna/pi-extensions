import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MenuScreen, MenuSettingItem, MenuTransition } from "./types.js";

const MENU_BINDINGS = [
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
	"tui.select.confirm",
	"tui.select.cancel",
] as const;
type MenuBinding = (typeof MENU_BINDINGS)[number];

interface RenderHost {
	requestRender(): void;
}

interface MenuKeybindings {
	matches(data: string, binding: MenuBinding): boolean;
	getKeys(binding: MenuBinding): readonly string[];
}

export type MenuScreenEvent =
	| { kind: "activate"; itemId: string }
	| { kind: "back" }
	| { kind: "close" };

export interface MenuSettingChange {
	itemId: string;
	value: string;
	previousValue: string;
}

export interface MenuMultiSelectChange {
	itemId: string;
	selected: boolean;
	previousSelected: boolean;
}

export interface MenuScreenComponent extends Component {
	handleInput(data: string): void;
	waitForPending(): Promise<void>;
	dispose?(): void;
}

type MenuChangeResponse<ScreenId extends string> =
	| boolean
	| { accepted: boolean; transition: MenuTransition<ScreenId> };

export interface MenuScreenComponentOptions<ScreenId extends string, ActionId extends string> {
	screen: MenuScreen<ScreenId, ActionId>;
	selectedItemId?: string;
	tui: RenderHost;
	theme: Pick<Theme, "fg" | "bold">;
	keybindings: MenuKeybindings;
	onEvent(event: MenuScreenEvent): void;
	onSelectionChange?(itemId: string): void;
	onSettingChange?(change: MenuSettingChange): Promise<MenuChangeResponse<ScreenId>>;
	onMultiSelectChange?(change: MenuMultiSelectChange): Promise<MenuChangeResponse<ScreenId>>;
	onTransition?(transition: MenuTransition<ScreenId>): void;
	onError?(error: unknown): void;
	onDispose?(): void;
}

export function createMenuScreenComponent<ScreenId extends string, ActionId extends string>(
	options: MenuScreenComponentOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	switch (options.screen.kind) {
		case "actions":
			return createActionsComponent(options as ActionsOptions<ScreenId, ActionId>);
		case "detail":
			return createDetailComponent(options as DetailOptions<ScreenId, ActionId>);
		case "settings":
			return createSettingsComponent(options as SettingsOptions<ScreenId, ActionId>);
		case "multiSelect":
			return createMultiSelectComponent(options as MultiSelectOptions<ScreenId, ActionId>);
	}
}

type ActionsOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
	ScreenId,
	ActionId
> & {
	screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "actions" }>;
};
type DetailOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
	ScreenId,
	ActionId
> & {
	screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "detail" }>;
};
type SettingsOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
	ScreenId,
	ActionId
> & {
	screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "settings" }>;
};
type MultiSelectOptions<
	ScreenId extends string,
	ActionId extends string,
> = MenuScreenComponentOptions<ScreenId, ActionId> & {
	screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "multiSelect" }>;
};

function createActionsComponent<ScreenId extends string, ActionId extends string>(
	options: ActionsOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	const items: SelectItem[] = options.screen.items.map((item) => ({
		value: item.id,
		label: safeMenuText(item.label),
		description: item.description ? safeMenuText(item.description) : undefined,
	}));
	const list = new SelectList(items, Math.min(items.length, 10), selectTheme(options.theme));
	setInitialSelection(list, items, options.selectedItemId);
	list.onSelectionChange = (item) => options.onSelectionChange?.(item.value);
	list.onSelect = (item) => {
		const source = options.screen.items.find((candidate) => candidate.id === item.value);
		if (!source?.disabled) options.onEvent({ kind: "activate", itemId: item.value });
	};
	list.onCancel = () => options.onEvent({ kind: options.screen.hint ?? "back" });
	return commonListComponent(
		options,
		list,
		options.screen.lines ?? [],
		options.screen.hint ?? "back",
	);
}

function createDetailComponent<ScreenId extends string, ActionId extends string>(
	options: DetailOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	let disposed = false;
	return {
		render(width) {
			return renderFrame(
				options.screen.title,
				options.screen.lines,
				[],
				options.screen.hint ?? "back",
				width,
				options,
			);
		},
		invalidate() {},
		handleInput(data) {
			if (disposed) return;
			if (matchesKey(data, Key.ctrl("c"))) options.onEvent({ kind: "close" });
			else if (options.keybindings.matches(data, "tui.select.cancel")) {
				options.onEvent({ kind: options.screen.hint ?? "back" });
			}
		},
		async waitForPending() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			options.onDispose?.();
		},
	};
}

// Pi's current SettingsList cannot initialize its cursor, enforce disabled rows, or expose search
// focus. Keep this adapter local until those behaviors are available through its public API.
function createSettingsComponent<ScreenId extends string, ActionId extends string>(
	options: SettingsOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	const committed = new Map(options.screen.items.map((item) => [item.id, item.currentValue]));
	const displayed = new Map(committed);
	const latestRequested = new Map<string, string>();
	let selectedIndex = Math.max(
		0,
		options.screen.items.findIndex((item) => item.id === options.selectedItemId),
	);
	let pending = Promise.resolve();
	let disposed = false;
	let closing = false;
	const closeAfterPending = (kind: "back" | "close") => {
		if (closing || disposed) return;
		closing = true;
		void pending.then(() => {
			if (!disposed) options.onEvent({ kind });
		});
	};
	const select = (index: number) => {
		if (options.screen.items.length === 0) return;
		selectedIndex = (index + options.screen.items.length) % options.screen.items.length;
		const item = options.screen.items[selectedIndex];
		if (item) options.onSelectionChange?.(item.id);
	};
	const activate = () => {
		const item = options.screen.items[selectedIndex];
		if (!item || item.disabled || closing || disposed) return;
		const values = item.values ?? [item.currentValue];
		if (values.length === 0) return;
		const currentValue = displayed.get(item.id) ?? item.currentValue;
		const currentIndex = values.indexOf(currentValue);
		const value = values[(currentIndex + 1) % values.length] ?? currentValue;
		displayed.set(item.id, value);
		latestRequested.set(item.id, value);
		const operation = pending.then(async () => {
			if (disposed) return;
			const previousValue = committed.get(item.id) ?? item.currentValue;
			let response: MenuChangeResponse<ScreenId> = false;
			try {
				response =
					(await options.onSettingChange?.({
						itemId: item.id,
						value,
						previousValue,
					})) ?? false;
			} catch (error) {
				options.onError?.(error);
			}
			if (disposed) return;
			const accepted = typeof response === "boolean" ? response : response.accepted;
			if (accepted) committed.set(item.id, value);
			else if (latestRequested.get(item.id) === value) displayed.set(item.id, previousValue);
			options.tui.requestRender();
			if (accepted && typeof response !== "boolean") {
				closing = true;
				void pending.then(() => {
					if (!disposed) options.onTransition?.(response.transition);
				});
			}
		});
		pending = operation.catch(() => undefined);
	};
	return {
		render(width) {
			const maxVisible = Math.min(options.screen.items.length, 13);
			const startIndex = Math.max(
				0,
				Math.min(
					selectedIndex - Math.floor(maxVisible / 2),
					options.screen.items.length - maxVisible,
				),
			);
			const visibleItems = options.screen.items.slice(startIndex, startIndex + maxVisible);
			const content = visibleItems.map((item, offset) => {
				const selected = startIndex + offset === selectedIndex;
				const label = safeMenuText(item.label);
				const value = safeMenuText(displayed.get(item.id) ?? item.currentValue);
				const unavailable = item.disabled ? " (unavailable)" : "";
				const text = `${selected ? "→ " : "  "}${label}  ${value}${unavailable}`;
				return selected ? options.theme.fg("accent", text) : text;
			});
			if (maxVisible < options.screen.items.length) {
				content.push(
					options.theme.fg("dim", `  (${selectedIndex + 1}/${options.screen.items.length})`),
				);
			}
			const selectedItem = options.screen.items[selectedIndex];
			if (selectedItem?.description) {
				content.push(
					"",
					...wrapTextWithAnsi(
						options.theme.fg("dim", `  ${safeMenuText(selectedItem.description)}`),
						Math.max(1, width),
					),
				);
			}
			return renderFrame(
				options.screen.title,
				options.screen.lines ?? [],
				content,
				"back",
				width,
				options,
				"change",
			);
		},
		invalidate() {},
		handleInput(data) {
			if (disposed || closing) return;
			if (matchesKey(data, Key.ctrl("c"))) closeAfterPending("close");
			else if (options.keybindings.matches(data, "tui.select.cancel")) {
				closeAfterPending("back");
			} else if (options.keybindings.matches(data, "tui.select.up")) {
				select(selectedIndex - 1);
			} else if (options.keybindings.matches(data, "tui.select.down")) {
				select(selectedIndex + 1);
			} else if (options.keybindings.matches(data, "tui.select.pageUp")) select(0);
			else if (options.keybindings.matches(data, "tui.select.pageDown")) {
				select(options.screen.items.length - 1);
			} else if (options.keybindings.matches(data, "tui.select.confirm") || data === " ") {
				activate();
			}
			options.tui.requestRender();
		},
		waitForPending: () => pending,
		dispose() {
			if (disposed) return;
			disposed = true;
			options.onDispose?.();
		},
	};
}

function createMultiSelectComponent<ScreenId extends string, ActionId extends string>(
	options: MultiSelectOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	const rows = [
		...options.screen.items.map((item) => ({ kind: "toggle" as const, item })),
		...(options.screen.actions ?? []).map((item) => ({ kind: "action" as const, item })),
	];
	const selected = new Map(options.screen.items.map((item) => [item.id, item.selected]));
	const committedSelected = new Map(selected);
	const revisions = new Map<string, number>();
	let selectedIndex = Math.max(
		0,
		rows.findIndex(({ item }) => item.id === options.selectedItemId),
	);
	let pending = Promise.resolve();
	let closing = false;
	let disposed = false;
	const closeAfterPending = (kind: "back" | "close") => {
		if (closing || disposed) return;
		closing = true;
		void pending.then(() => {
			if (!disposed) options.onEvent({ kind });
		});
	};
	const move = (delta: number) => {
		if (rows.length === 0) return;
		selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
		const row = rows[selectedIndex];
		if (row) options.onSelectionChange?.(row.item.id);
	};
	const activate = () => {
		const row = rows[selectedIndex];
		if (!row || row.item.disabled) return;
		if (row.kind === "action") {
			if (closing || disposed) return;
			closing = true;
			void pending.then(() => {
				if (!disposed) options.onEvent({ kind: "activate", itemId: row.item.id });
			});
			return;
		}
		const item = row.item;
		const previousSelected = selected.get(item.id) ?? false;
		const nextSelected = !previousSelected;
		selected.set(item.id, nextSelected);
		const revision = (revisions.get(item.id) ?? 0) + 1;
		revisions.set(item.id, revision);
		const operation = pending.then(async () => {
			if (disposed) return;
			let response: MenuChangeResponse<ScreenId> = false;
			try {
				response =
					(await options.onMultiSelectChange?.({
						itemId: item.id,
						selected: nextSelected,
						previousSelected,
					})) ?? false;
			} catch (error) {
				options.onError?.(error);
			}
			if (disposed) return;
			const accepted = typeof response === "boolean" ? response : response.accepted;
			if (accepted) committedSelected.set(item.id, nextSelected);
			else if (revisions.get(item.id) === revision) {
				selected.set(item.id, committedSelected.get(item.id) ?? false);
			}
			options.tui.requestRender();
			if (accepted && typeof response !== "boolean") {
				closing = true;
				void pending.then(() => {
					if (!disposed) options.onTransition?.(response.transition);
				});
			}
		});
		pending = operation.catch(() => undefined);
	};
	return {
		render(width) {
			const content = rows.map((row, index) => {
				const prefix = index === selectedIndex ? "› " : "  ";
				const marker = row.kind === "toggle" ? `${selected.get(row.item.id) ? "[x]" : "[ ]"} ` : "";
				const label = `${prefix}${marker}${safeMenuText(row.item.label)}`;
				return index === selectedIndex ? options.theme.fg("accent", label) : label;
			});
			return renderFrame(
				options.screen.title,
				options.screen.lines ?? [],
				content,
				options.screen.hint ?? "back",
				width,
				options,
				rows[selectedIndex]?.kind === "action" ? "select" : "toggle",
			);
		},
		invalidate() {},
		handleInput(data) {
			if (disposed || closing) return;
			if (matchesKey(data, Key.ctrl("c"))) closeAfterPending("close");
			else if (options.keybindings.matches(data, "tui.select.cancel")) {
				closeAfterPending(options.screen.hint ?? "back");
			} else if (options.keybindings.matches(data, "tui.select.up")) move(-1);
			else if (options.keybindings.matches(data, "tui.select.down")) move(1);
			else if (options.keybindings.matches(data, "tui.select.pageUp")) {
				selectedIndex = 0;
				const row = rows[selectedIndex];
				if (row) options.onSelectionChange?.(row.item.id);
			} else if (options.keybindings.matches(data, "tui.select.pageDown")) {
				selectedIndex = Math.max(0, rows.length - 1);
				const row = rows[selectedIndex];
				if (row) options.onSelectionChange?.(row.item.id);
			} else if (options.keybindings.matches(data, "tui.select.confirm") || data === " ") {
				activate();
			}
			options.tui.requestRender();
		},
		waitForPending: () => pending,
		dispose() {
			if (disposed) return;
			disposed = true;
			options.onDispose?.();
		},
	};
}

function commonListComponent<ScreenId extends string, ActionId extends string>(
	options: MenuScreenComponentOptions<ScreenId, ActionId>,
	list: SelectList,
	lines: readonly string[],
	destination: "back" | "close",
): MenuScreenComponent {
	let disposed = false;
	return {
		render(width) {
			return renderFrame(
				options.screen.title,
				lines,
				list.render(Math.max(1, width)),
				destination,
				width,
				options,
			);
		},
		invalidate() {
			list.invalidate();
		},
		handleInput(data) {
			if (disposed) return;
			if (matchesKey(data, Key.ctrl("c"))) {
				options.onEvent({ kind: "close" });
				return;
			}
			if (options.keybindings.matches(data, "tui.select.cancel")) {
				options.onEvent({ kind: destination });
				return;
			}
			list.handleInput(data);
			options.tui.requestRender();
		},
		async waitForPending() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			options.onDispose?.();
		},
	};
}

function renderFrame<ScreenId extends string, ActionId extends string>(
	title: string,
	lines: readonly string[],
	content: readonly string[],
	destination: "back" | "close",
	width: number,
	options: MenuScreenComponentOptions<ScreenId, ActionId>,
	confirmAction = "select",
): string[] {
	const safeWidth = Math.max(1, width);
	const result = [
		...wrapTextWithAnsi(
			options.theme.fg("accent", options.theme.bold(safeMenuText(title))),
			safeWidth,
		),
		...lines.flatMap((line) =>
			wrapTextWithAnsi(options.theme.fg("muted", safeMenuText(line)), safeWidth),
		),
		...(content.length > 0 ? ["", ...content] : []),
		...wrapTextWithAnsi(
			options.theme.fg("dim", menuHint(options.keybindings, destination, confirmAction)),
			safeWidth,
		),
	];
	return result.map((line) => truncateToWidth(line, safeWidth, ""));
}

function menuHint(
	keybindings: MenuKeybindings,
	destination: "back" | "close",
	confirmAction: string,
) {
	const up = bindingText(keybindings, "tui.select.up");
	const down = bindingText(keybindings, "tui.select.down");
	const confirm = bindingText(keybindings, "tui.select.confirm");
	const cancel = bindingText(keybindings, "tui.select.cancel", "ctrl+c");
	return [
		...(up || down ? [`${[up, down].filter(Boolean).join("/")} navigate`] : []),
		...(confirm ? [`${confirm} ${confirmAction}`] : []),
		...(cancel ? [`${cancel} ${destination}`] : []),
		...(destination === "back" ? ["ctrl+c close"] : []),
	].join(" • ");
}

function bindingText(keybindings: MenuKeybindings, binding: MenuBinding, excluded?: string) {
	return keybindings
		.getKeys(binding)
		.filter((key) => key !== excluded)
		.map((key) => {
			if (key === "up") return "↑";
			if (key === "down") return "↓";
			if (key === "escape") return "esc";
			return key;
		})
		.join("/");
}

function selectTheme(theme: Pick<Theme, "fg">) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function setInitialSelection(list: SelectList, items: readonly SelectItem[], selectedId?: string) {
	if (!selectedId) return;
	const index = items.findIndex((item) => item.value === selectedId);
	if (index >= 0) list.setSelectedIndex(index);
}

export function safeMenuText(value: unknown) {
	return Array.from(String(value), (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
	})
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
}

export function settingForAction<ActionId extends string>(
	screen: Extract<MenuScreen<string, ActionId>, { kind: "settings" }>,
	itemId: string,
): MenuSettingItem<ActionId> | undefined {
	return screen.items.find((item) => item.id === itemId);
}
