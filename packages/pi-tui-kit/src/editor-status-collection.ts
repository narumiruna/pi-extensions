export interface EditorStatusCollectionInput<T> {
  readonly id: string;
  readonly value: T;
  readonly revision: string;
}

export interface EditorStatusCollectionItem<T> {
  readonly id: string;
  readonly value: T;
  readonly mode: "expanded" | "compact";
}

export interface EditorStatusItemHandle {
  compact(): boolean;
  expand(): boolean;
  remove(): boolean;
}

export interface EditorStatusCollection<T> {
  replace(items: readonly EditorStatusCollectionInput<T>[]): void;
  snapshot(): readonly EditorStatusCollectionItem<T>[];
  item(id: string): EditorStatusItemHandle | undefined;
  dispose(): void;
}

export interface EditorStatusCollectionOptions<T> {
  maxItems: number;
  /** Per-item size limit, not a combined content limit. */
  maxContentSize: number;
  /** Measure an immutable owner snapshot in safe, nonnegative integer units. */
  measure(value: T): number;
}

interface Entry<T> extends EditorStatusCollectionInput<T> {
  token: object;
  mode: "expanded" | "compact";
  removed: boolean;
}

function requireSize(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
}

/** Bounded authoritative snapshots with presentation-only item controls. */
export function createEditorStatusCollection<T>(options: EditorStatusCollectionOptions<T>): EditorStatusCollection<T> {
  const { maxItems, maxContentSize, measure } = options;
  requireSize(maxItems, "maxItems");
  requireSize(maxContentSize, "maxContentSize");
  let entries = new Map<string, Entry<T>>();
  let disposed = false;
  let replacing = false;

  function current(id: string, token: object): Entry<T> | undefined {
    const entry = entries.get(id);
    return !disposed && !replacing && entry?.token === token && !entry.removed ? entry : undefined;
  }

  return {
    replace(items) {
      if (disposed) throw new Error("Editor status collection is disposed");
      if (replacing) throw new Error("Editor status collection replacement is already active");
      replacing = true;
      try {
        if (!Array.isArray(items)) throw new RangeError("Editor status items must be an array");
        const length = items.length;
        requireSize(length, "Item count");
        if (length > maxItems) throw new RangeError("Editor status collection exceeds maxItems");
        // Capture a bounded indexed snapshot before calling owner code. A custom
        // iterator or measure() mutation must not bypass the validated capacity.
        const inputs: EditorStatusCollectionInput<T>[] = [];
        const ids = new Set<string>();
        for (let index = 0; index < length; index++) {
          const item = items[index];
          if (!item) throw new RangeError("Editor status items must not be empty");
          const { id, revision, value } = item;
          if (typeof id !== "string" || id.length === 0 || ids.has(id)) {
            throw new RangeError("Editor status item IDs must be nonempty, unique strings");
          }
          if (typeof revision !== "string") throw new RangeError("Editor status revision must be a string");
          ids.add(id);
          inputs.push({ id, revision, value });
        }
        const next = new Map<string, Entry<T>>();
        let total = 0;
        for (const item of inputs) {
          const size = measure(item.value);
          if (disposed) throw new Error("Editor status collection is disposed");
          requireSize(size, "Measured content size");
          total += size;
          if (size > maxContentSize || !Number.isSafeInteger(total)) {
            throw new RangeError("Editor status content exceeds its per-item limit or safe total size");
          }
          const previous = entries.get(item.id);
          next.set(item.id, {
            id: item.id,
            value: item.value,
            revision: item.revision,
            token: previous && previous.revision === item.revision ? previous.token : {},
            mode: previous?.mode ?? "expanded",
            // A removed ID stays hidden until it is absent from an authoritative snapshot.
            removed: previous?.removed ?? false,
          });
        }
        if (disposed) throw new Error("Editor status collection is disposed");
        entries = next;
      } finally {
        replacing = false;
      }
    },
    snapshot() {
      return Object.freeze(
        [...entries.values()]
          .filter((entry) => !entry.removed)
          .map(({ id, value, mode }) => Object.freeze({ id, value, mode })),
      );
    },
    item(id) {
      const entry = entries.get(id);
      if (disposed || !entry || entry.removed) return undefined;
      const token = entry.token;
      function setMode(mode: "expanded" | "compact") {
        const latest = current(id, token);
        if (!latest || latest.mode === mode) return false;
        latest.mode = mode;
        return true;
      }
      return {
        compact: () => setMode("compact"),
        expand: () => setMode("expanded"),
        remove() {
          const latest = current(id, token);
          if (!latest) return false;
          latest.removed = true;
          return true;
        },
      };
    },
    dispose() {
      disposed = true;
      entries.clear();
    },
  };
}
