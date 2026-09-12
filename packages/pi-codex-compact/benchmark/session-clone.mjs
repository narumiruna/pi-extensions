function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function mappedId(ids, sourceId, label) {
  const mapped = ids.get(sourceId);
  if (!mapped) throw new Error(`${label} references an entry outside the cloned branch`);
  return mapped;
}

export function cloneSessionBranch(sdk, entries, cwd) {
  if (!sdk?.SessionManager?.inMemory) throw new Error("Pi SessionManager is unavailable");
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("A non-empty session branch is required for cloning");
  }
  const manager = sdk.SessionManager.inMemory(cwd);
  const ids = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedParent = index === 0 ? null : entries[index - 1].id;
    if (entry.parentId !== expectedParent) {
      throw new Error("Session clone accepts only one linear active branch");
    }
    let newId;
    switch (entry.type) {
      case "message":
        newId = manager.appendMessage(cloneValue(entry.message));
        break;
      case "thinking_level_change":
        newId = manager.appendThinkingLevelChange(entry.thinkingLevel);
        break;
      case "model_change":
        newId = manager.appendModelChange(entry.provider, entry.modelId);
        break;
      case "compaction":
        newId = manager.appendCompaction(
          entry.summary,
          mappedId(ids, entry.firstKeptEntryId, "Compaction"),
          entry.tokensBefore,
          cloneValue(entry.details),
          entry.fromHook,
          cloneValue(entry.usage),
        );
        break;
      case "custom":
        newId = manager.appendCustomEntry(entry.customType, cloneValue(entry.data));
        break;
      case "custom_message":
        newId = manager.appendCustomMessageEntry(
          entry.customType,
          cloneValue(entry.content),
          entry.display,
          cloneValue(entry.details),
        );
        break;
      case "label":
        newId = manager.appendLabelChange(mappedId(ids, entry.targetId, "Label"), entry.label);
        break;
      case "session_info":
        newId = manager.appendSessionInfo(entry.name ?? "");
        break;
      case "branch_summary":
        throw new Error("Benchmark probe cloning does not support branch summaries");
      default:
        throw new Error(`Unsupported session entry type: ${entry.type}`);
    }
    ids.set(entry.id, newId);
  }
  return manager;
}
