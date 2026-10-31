import { type AssistantMetadataData, captureAssistantMetadata } from "./metadata.js";
import { METADATA_PRESETS } from "./metadata-settings.js";
import { isRecord, isValidTimestamp, STAMP_ENTRY_TYPE } from "./stamp-data.js";

interface MetadataSource {
  getLeafId(): string | null;
  getBranch(): readonly unknown[];
}

/** Read ordinary metadata for an existing Stamp without changing its persisted data. */
export function createMessageMetadataReader() {
  let source: MetadataSource | undefined;
  let loaded = false;
  let leaf: string | null | undefined;
  const messages = new Map<string, unknown>();
  const metadata = new Map<string, AssistantMetadataData | undefined>();
  const reset = () => {
    loaded = false;
    leaf = undefined;
    messages.clear();
    metadata.clear();
  };
  return {
    bind(next: MetadataSource) {
      source = next;
      reset();
    },
    clear() {
      source = undefined;
      reset();
    },
    get(entryId: string): AssistantMetadataData | undefined {
      if (!source || typeof entryId !== "string" || entryId.length === 0) return undefined;
      const currentLeaf = source.getLeafId();
      if (!loaded || leaf !== currentLeaf) {
        reset();
        const latest = new Map<number, unknown>();
        for (const entry of source.getBranch()) {
          if (!isRecord(entry)) continue;
          if (entry.type === "message" && isRecord(entry.message)) {
            const message = entry.message;
            if (message.role === "assistant" && isValidTimestamp(message.timestamp)) {
              latest.set(message.timestamp, message);
            }
            continue;
          }
          if (entry.type !== "custom" || entry.customType !== STAMP_ENTRY_TYPE || typeof entry.id !== "string")
            continue;
          const data = entry.data;
          if (
            !isRecord(data) ||
            data.role !== "assistant" ||
            ![1, 2, 3, 4, 5, 6, 7, 8].includes(data.version as number) ||
            !isValidTimestamp(data.timestamp)
          )
            continue;
          const message = latest.get(data.timestamp);
          if (message !== undefined) messages.set(entry.id, message);
        }
        leaf = currentLeaf;
        loaded = true;
      }
      if (!messages.has(entryId)) return undefined;
      if (!metadata.has(entryId)) {
        // These flags never read raw response IDs, diagnostics, content, or Thinking.
        metadata.set(entryId, captureAssistantMetadata(messages.get(entryId), METADATA_PRESETS.detailed));
      }
      return metadata.get(entryId);
    },
  };
}
