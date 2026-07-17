import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PersistentSelectorRow<T> {
	value: T;
	label: string;
}

export interface PersistentSelectorView<T> {
	title: string;
	rows: PersistentSelectorRow<T>[];
	help?: string;
}

export type PersistentSelectorActivation = "stay" | "reset" | "close";

export async function showPersistentSelector<T>(
	ctx: ExtensionContext,
	getView: () => PersistentSelectorView<T>,
	onActivate: (value: T) => PersistentSelectorActivation,
): Promise<boolean> {
	const result = await ctx.ui.custom<"closed" | undefined>((tui, theme, keybindings, done) => {
		let selectedIndex = 0;
		const currentView = () => {
			const view = getView();
			selectedIndex = Math.min(selectedIndex, Math.max(0, view.rows.length - 1));
			return view;
		};
		const moveSelection = (delta: number) => {
			const { rows } = currentView();
			if (rows.length === 0) return;
			selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
		};
		const activateSelectedRow = () => {
			const row = currentView().rows[selectedIndex];
			if (!row) return;
			const action = onActivate(row.value);
			if (action === "reset") selectedIndex = 0;
			else if (action === "close") done("closed");
		};

		return {
			invalidate() {},
			render(width: number) {
				const view = currentView();
				return [
					theme.fg("accent", theme.bold(clipLine(view.title, width))),
					"",
					...view.rows.map((row, index) => {
						const prefix = index === selectedIndex ? "› " : "  ";
						const line = clipLine(`${prefix}${row.label}`, width);
						return index === selectedIndex ? theme.fg("accent", line) : line;
					}),
					"",
					theme.fg(
						"dim",
						clipLine(view.help ?? "↑↓ navigate • Enter/Space toggle • Esc close", width),
					),
				];
			},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.up")) {
					moveSelection(-1);
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.down")) {
					moveSelection(1);
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.pageUp")) {
					selectedIndex = 0;
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.pageDown")) {
					selectedIndex = Math.max(0, currentView().rows.length - 1);
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm") || data === " ") {
					activateSelectedRow();
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.cancel")) done("closed");
			},
		};
	});
	return result === "closed";
}

function clipLine(value: string, width: number) {
	return Array.from(value).slice(0, Math.max(0, width)).join("");
}
