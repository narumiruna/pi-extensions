interface SelectionItem {
  id: string;
}

/** Package-internal stable-ID selection movement shared by choice interactions. */
export class SelectionController<Item extends SelectionItem> {
  readonly items: readonly Item[];
  #selectedIndex: number;

  constructor(items: readonly Item[], initialItemId?: string) {
    this.items = items;
    const initialIndex = initialItemId ? items.findIndex((item) => item.id === initialItemId) : -1;
    this.#selectedIndex = items.length === 0 ? -1 : Math.max(0, initialIndex);
  }

  get selectedIndex(): number {
    return this.#selectedIndex;
  }

  get selectedItem(): Item | undefined {
    return this.items[this.#selectedIndex];
  }

  select(index: number): Item | undefined {
    if (this.items.length === 0) return undefined;
    this.#selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
    return this.selectedItem;
  }

  move(delta: number): Item | undefined {
    if (this.items.length === 0) return undefined;
    this.#selectedIndex = (((this.#selectedIndex + delta) % this.items.length) + this.items.length) % this.items.length;
    return this.selectedItem;
  }

  page(delta: number, viewportSize: number): Item | undefined {
    return this.select(this.#selectedIndex + delta * Math.max(1, viewportSize));
  }

  first(): Item | undefined {
    return this.select(0);
  }

  last(): Item | undefined {
    return this.select(this.items.length - 1);
  }
}
