export type EditorStatusMode = "default" | "expanded" | "compact" | "hidden";
export type EditorStatusTrigger = "manual" | "user-message" | "settled-cycle";

export interface EditorStatusView {
  readonly mode: EditorStatusMode;
  readonly pinned: boolean;
  readonly trigger: EditorStatusTrigger;
  /** Explicit view choices cancel the selected automatic rule. */
  setMode(mode: EditorStatusMode): void;
  setPinned(pinned: boolean): void;
  setTrigger(trigger: EditorStatusTrigger): void;
  /** Rearm on semantic changes only; identical values do not renew a rule. */
  revision(value: string): void;
  /** Repeated starts before settlement belong to the same cycle, including retries. */
  agentStarted(): void;
  userMessage(): void;
  /** Owners determine eligibility; a future cycle also needs its own post-arm user message. */
  settled(eligible: boolean): void;
  reset(): void;
  dispose(): void;
}

export interface EditorStatusViewOptions {
  onChange(): void;
  /** Owner policy, including disabled display and protected domain conditions. */
  canCompact(): boolean;
}

/** Session-local presentation only. Owners supply consumed-message and settled-cycle hooks. */
export function createEditorStatusView(options: EditorStatusViewOptions): EditorStatusView {
  let mode: EditorStatusMode = "default";
  let pinned = false;
  let trigger: EditorStatusTrigger = "manual";
  let contentRevision: string | undefined;
  let userOrdinal = 0;
  let cycleOrdinal = 0;
  let cycle: { ordinal: number; userOrdinal: number } | undefined;
  let armedUser = 0;
  let armedCycle = 0;
  let disposed = false;

  function arm() {
    armedUser = userOrdinal;
    armedCycle = cycleOrdinal;
  }

  const blocked = () => disposed || pinned || mode === "hidden";

  function compact() {
    if (blocked()) return;
    const expectedTrigger = trigger;
    const expectedRevision = contentRevision;
    if (!options.canCompact() || blocked() || trigger !== expectedTrigger || contentRevision !== expectedRevision)
      return;
    mode = "compact";
    trigger = "manual";
    options.onChange();
  }

  return {
    get mode() {
      return mode;
    },
    get pinned() {
      return pinned;
    },
    get trigger() {
      return trigger;
    },
    setMode(next) {
      if (disposed || (mode === next && trigger === "manual")) return;
      mode = next;
      trigger = "manual";
      options.onChange();
    },
    setPinned(next) {
      if (disposed || pinned === next) return;
      pinned = next;
      options.onChange();
    },
    setTrigger(next) {
      if (disposed || trigger === next) return;
      trigger = next;
      arm();
      options.onChange();
    },
    revision(value) {
      if (disposed || contentRevision === value) return;
      contentRevision = value;
      arm();
    },
    agentStarted() {
      if (disposed || cycle) return;
      cycle = { ordinal: ++cycleOrdinal, userOrdinal: 0 };
    },
    userMessage() {
      if (disposed) return;
      userOrdinal++;
      if (cycle) cycle.userOrdinal = userOrdinal;
      if (trigger === "user-message" && userOrdinal > armedUser) compact();
    },
    settled(eligible) {
      if (disposed || !cycle) return;
      const completed = cycle;
      cycle = undefined;
      if (
        eligible &&
        trigger === "settled-cycle" &&
        completed.ordinal > armedCycle &&
        completed.userOrdinal > armedUser
      ) {
        compact();
      }
    },
    reset() {
      if (disposed) return;
      const changed = mode !== "default" || pinned || trigger !== "manual";
      mode = "default";
      pinned = false;
      trigger = "manual";
      contentRevision = undefined;
      userOrdinal = 0;
      cycleOrdinal = 0;
      cycle = undefined;
      arm();
      if (changed) options.onChange();
    },
    dispose() {
      disposed = true;
      cycle = undefined;
    },
  };
}
