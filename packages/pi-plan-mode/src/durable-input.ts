import type { EntryRecord, InboxItem } from "@earendil-works/pi-durable";
import { fingerprint } from "./durable-state.js";

type InputMarker = { workflowId: string; revision: number; operationId: string };

/** Native request IDs deduplicate by type, not payload. All consumers use this exact marker contract. */
export function matchesPlanInput(
  entry: EntryRecord | undefined,
  owner: number,
  marker: InputMarker,
  content: string,
): boolean {
  return (
    entry?.conversationId === owner &&
    entry.kind === "plan-mode.input" &&
    entry.data !== undefined &&
    fingerprint(entry.data) === fingerprint(marker) &&
    entry.model?.length === 1 &&
    entry.model[0]?.role === "user" &&
    entry.model[0].content === content
  );
}

export function matchesQueuedPlanInput(item: InboxItem | undefined, marker: InputMarker, content: string): boolean {
  return (
    item !== undefined &&
    item.mode !== "write" &&
    item.content === content &&
    item.entry?.kind === "plan-mode.input" &&
    item.entry.data !== undefined &&
    fingerprint(item.entry.data) === fingerprint(marker)
  );
}
