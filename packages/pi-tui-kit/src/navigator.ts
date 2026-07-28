import type { MenuTransition } from "./types.js";

export interface MenuNavigator<ScreenId extends string> {
	readonly current: ScreenId;
	readonly closed: boolean;
	apply(transition: MenuTransition<ScreenId>): "active" | "closed";
	rememberSelection(screen: ScreenId, itemId: string): void;
	selectionFor(screen: ScreenId, availableItemIds: readonly string[]): string | undefined;
}

export function createMenuNavigator<ScreenId extends string>(
	start: ScreenId,
): MenuNavigator<ScreenId> {
	const stack = [start];
	const selections = new Map<ScreenId, string>();
	let closed = false;
	return {
		get current() {
			const current = stack.at(-1);
			if (current === undefined) throw new Error("Menu is closed");
			return current;
		},
		get closed() {
			return closed;
		},
		apply(transition) {
			if (closed) return "closed";
			switch (transition.kind) {
				case "stay":
					break;
				case "to":
					stack.push(transition.screen);
					break;
				case "back":
					if (stack.length > 1) stack.pop();
					else closed = true;
					break;
				case "close":
					closed = true;
					break;
			}
			return closed ? "closed" : "active";
		},
		rememberSelection(screen, itemId) {
			selections.set(screen, itemId);
		},
		selectionFor(screen, availableItemIds) {
			if (availableItemIds.length === 0) return undefined;
			const remembered = selections.get(screen);
			if (remembered && availableItemIds.includes(remembered)) return remembered;
			const fallback = availableItemIds[0];
			if (fallback !== undefined) selections.set(screen, fallback);
			return fallback;
		},
	};
}
