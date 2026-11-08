import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UPDATE_CHANNEL = "extension-status:v1:update";
const REQUEST_CHANNEL = "extension-status:v1:request";
const ACTIVITIES = new Set([
  "idle",
  "checking",
  "working",
  "pushing",
  "pulling",
  "resolving",
  "retry",
  "blocked",
  "local-change",
  "remote-change",
  "review",
] as const);

export type ExtensionStatusActivity =
  | "idle"
  | "checking"
  | "working"
  | "pushing"
  | "pulling"
  | "resolving"
  | "retry"
  | "blocked"
  | "local-change"
  | "remote-change"
  | "review";

export interface ExtensionStatusPresentation {
  readonly value: string;
  readonly activity: ExtensionStatusActivity;
  readonly reason?: string;
}

export interface ExtensionStatusMetadata {
  get(key: string, value: string): ExtensionStatusPresentation | undefined;
  reconcile(statuses: ReadonlyMap<string, string>): void;
  dispose(): void;
}

function parseMetadata(data: Record<string, unknown>): {
  presentation?: ExtensionStatusPresentation;
  withdrawal: boolean;
} {
  if (Array.isArray(data)) return { withdrawal: false };
  // Capture fields once: accessors and proxy traps can synchronously replace the current state.
  const { version, value, activity, reason } = data;
  const hasValue = Object.hasOwn(data, "value");
  const hasActivity = "activity" in data;
  const hasReason = "reason" in data;
  const withdrawal = version === 1 && hasValue && value === undefined && !hasActivity && !hasReason;
  if (
    version !== 1 ||
    !hasValue ||
    typeof value !== "string" ||
    value.length === 0 ||
    !ACTIVITIES.has(activity as ExtensionStatusActivity)
  )
    return { withdrawal };
  if (activity === "retry" || activity === "blocked") {
    // JavaScript's $ also matches before a final newline; require the complete safe label.
    if (typeof reason !== "string" || /^[a-z][a-z0-9-]{0,31}$/.exec(reason)?.[0] !== reason) return { withdrawal };
    return { presentation: Object.freeze({ value, activity, reason }), withdrawal };
  }
  if (hasReason) return { withdrawal };
  return { presentation: Object.freeze({ value, activity: activity as ExtensionStatusActivity }), withdrawal };
}

/** Optional display metadata; the raw Pi status map remains authoritative. */
export function subscribeExtensionStatusMetadata(
  events: ExtensionAPI["events"],
  sessionManager: object,
  getStatuses: () => ReadonlyMap<string, string>,
  requestRender: () => void,
): ExtensionStatusMetadata {
  const records = new Map<string, ExtensionStatusPresentation>();
  const liveKeys = new Set<string>();
  const requestId = {};
  let observedStatuses = new Map<string, string>();
  try {
    observedStatuses = new Map(getStatuses());
  } catch {
    // A raw-map read failure must leave the ordinary footer available.
  }
  let disposed = false;
  let revision = 0;
  const keyRevisions = new Map<string, number>();
  const isCurrent = (key: string, owner: number) => !disposed && keyRevisions.get(key) === owner;
  let unsubscribe: (() => void) | undefined;

  const reconcile = (statuses: ReadonlyMap<string, string>, ownerKey?: string) => {
    if (disposed) return;
    const before = revision;
    const snapshot = new Map(statuses);
    if (disposed || revision !== before) return;
    for (const [key, value] of observedStatuses) {
      if (snapshot.get(key) === value) continue;
      records.delete(key);
      // An observed raw replacement must also fence off a delayed same-value snapshot.
      liveKeys.add(key);
      if (key !== ownerKey) keyRevisions.set(key, ++revision);
    }
    for (const key of snapshot.keys()) {
      if (observedStatuses.has(key)) continue;
      liveKeys.add(key);
      if (key !== ownerKey) keyRevisions.set(key, ++revision);
    }
    observedStatuses = snapshot;
  };

  const metadata: ExtensionStatusMetadata = {
    get(key, value) {
      const presentation = records.get(key);
      return presentation?.value === value ? presentation : undefined;
    },
    reconcile(statuses) {
      reconcile(statuses);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      keyRevisions.clear();
      records.clear();
      liveKeys.clear();
      observedStatuses.clear();
      try {
        unsubscribe?.();
      } catch {
        // Optional metadata cleanup must not prevent footer disposal.
      }
      unsubscribe = undefined;
    },
  };

  const receive = (payload: unknown) => {
    if (disposed || !payload || typeof payload !== "object") return;
    const entered = revision;
    let key: string;
    let snapshot: boolean;
    const data = payload as Record<string, unknown>;
    try {
      const rawKey = data.key;
      const manager = data.sessionManager;
      snapshot = "requestId" in data;
      const replyId = snapshot ? data.requestId : undefined;
      if (disposed || manager !== sessionManager || typeof rawKey !== "string" || !rawKey) return;
      key = rawKey;
      if ((keyRevisions.get(key) ?? 0) > entered) return;
      if (snapshot && (replyId !== requestId || liveKeys.has(key))) return;
    } catch {
      return;
    }

    // Only an accepted envelope for this key can supersede its in-flight update.
    const owner = ++revision;
    keyRevisions.set(key, owner);
    if (!snapshot) liveKeys.add(key);
    const previous = records.get(key);
    try {
      const { presentation, withdrawal } = parseMetadata(data);
      if (!isCurrent(key, owner)) return;
      // Read after payload accessors, and copy before touching the cache: either operation can reenter.
      const reading = revision;
      const statuses = new Map(getStatuses());
      if (!isCurrent(key, owner)) return;
      if (revision !== reading) {
        // An unstable read must not retain old hidden state or erase a newer sibling record.
        records.delete(key);
      } else {
        reconcile(statuses, key);
        if (!isCurrent(key, owner) || (snapshot && liveKeys.has(key))) return;
        if (presentation && statuses.get(key) === presentation.value) {
          records.set(key, presentation);
        } else if (!snapshot || withdrawal) {
          // Invalid live data and explicit withdrawals restore the existing raw-text path.
          records.delete(key);
        }
      }
    } catch {
      if (!isCurrent(key, owner)) return;
      if (!snapshot) records.delete(key);
    }
    if (isCurrent(key, owner) && previous !== records.get(key)) {
      try {
        requestRender();
      } catch {
        // A closed UI must not turn optional metadata delivery into an event-bus error.
      }
    }
  };

  try {
    unsubscribe = events.on(UPDATE_CHANNEL, receive);
  } catch {
    // Metadata support must not prevent the footer from loading.
    return metadata;
  }
  try {
    events.emit(REQUEST_CHANNEL, { version: 1, sessionManager, requestId });
  } catch {
    // Keep the live subscription usable when a snapshot request fails.
  }
  return metadata;
}
