import {
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  getInitialSystemMessage,
} from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  type ExtensionContext,
  parseSkillBlock,
  type SessionEntry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

import { ancestry } from "./ancestry.js";
import { type CostModelResolver, cacheHistory } from "./cache-history.js";
import type { Collector } from "./collector.js";
import { captureContext, sessionContext } from "./context.js";
import { correlatedCalls } from "./correlation.js";
import { EntryIndex } from "./entry-index.js";
import { readableSummary } from "./entry-summary.js";
import { identityIssue, recordedLeaf } from "./identity.js";
import type { BranchView, ContextComposition, DetailView, EntrySummary, SkillView, Snapshot } from "./model.js";
import { nativeProjection } from "./native-projection.js";
import { capture, displayText, readSessionId, readSessionName } from "./privacy.js";
import { systemReplayIssue } from "./system-message.js";
import { projectToolCatalog } from "./tool-catalog.js";

export function summarize(entry: SessionEntry, label?: string): EntrySummary {
  const issue = identityIssue(entry);
  if (issue) throw new Error(issue);
  const message = entry.type === "message" ? entry.message : undefined;
  const kind = displayText(message ? message.role : entry.type).slice(0, 512);
  const value = message && "content" in message ? message.content : entry;
  const preview = capture(value, 180).value;
  const name =
    entry.type === "custom" || entry.type === "custom_message"
      ? entry.customType
      : entry.type === "model_change"
        ? entry.modelId
        : entry.type === "thinking_level_change"
          ? entry.thinkingLevel
          : message?.role === "assistant"
            ? message.model
            : message?.role === "toolResult"
              ? message.toolName
              : undefined;
  const displayName = typeof name === "string" ? displayText(name) : undefined;
  return {
    id: entry.id,
    parentId: entry.parentId,
    ...readableSummary(entry),
    internal: ["custom", "label", "session_info", "usage"].includes(entry.type) ? true : undefined,
    kind,
    timestamp: entry.timestamp,
    name: displayName?.slice(0, 512),
    nameTruncated: displayName !== undefined && displayName.length > 512 ? true : undefined,
    tokens:
      message?.role === "assistant" && Number.isFinite(message.usage?.totalTokens)
        ? message.usage?.totalTokens
        : undefined,
    status:
      message?.role === "toolResult" && typeof message.isError === "boolean"
        ? message.isError
          ? "error"
          : "success"
        : message?.role === "assistant" && message.stopReason === "error"
          ? "error"
          : message?.role === "assistant" && message.stopReason === "aborted"
            ? "cancelled"
            : undefined,
    toolCallId: message?.role === "toolResult" ? message.toolCallId : undefined,
    label: displayText(
      typeof label === "string" ? label : typeof preview === "string" ? preview : JSON.stringify(preview),
    ).slice(0, 180),
  };
}

export function snapshot(
  manager: ReadonlySessionManager,
  collector: Collector,
  generation: string,
  revision: number,
  prompt: string,
  tools: ToolInfo[],
  active: string[],
  skills: SkillView[],
  index = new EntryIndex(manager.getEntries()),
  observedContext?: ContextComposition,
  resolveCostModel?: CostModelResolver,
): Snapshot {
  const entries = index.entries;
  const owning = new Map<string, { id: string; ids: Set<string> }>();
  const invalidEntries: NonNullable<Snapshot["invalidEntries"]> = [];
  let invalidEntryCount = 0;
  const nodes: EntrySummary[] = [];
  const leafId = recordedLeaf(manager, index.duplicates);
  const reserved = new Set(leafId ? ancestry(manager, leafId, index).path.map((entry) => entry.id) : []);
  let remaining = 10000 - reserved.size;
  const included = entries.flatMap((entry, ordinal) =>
    reserved.has(entry.id) || remaining-- > 0 ? [{ entry, ordinal }] : [],
  );
  for (const { ordinal, entry } of included) {
    const reason = index.duplicates.has(entry.id) ? "duplicate entry id" : identityIssue(entry);
    if (reason) {
      invalidEntryCount++;
      if (invalidEntries.length < 20) invalidEntries.push({ index: ordinal, reason, raw: capture(entry, 2048) });
      continue;
    }
    const source =
      entry.type === "message" && entry.message.role === "assistant"
        ? {
            id: entry.id,
            ids: new Set(
              (Array.isArray(entry.message.content) ? entry.message.content : [])
                .filter((block) => block.type === "toolCall")
                .map((block) => block.id),
            ),
          }
        : entry.parentId
          ? owning.get(entry.parentId)
          : undefined;
    if (source) owning.set(entry.id, source);
    const label = manager.getLabel(entry.id);
    if (label !== undefined && typeof label !== "string") {
      invalidEntryCount++;
      if (invalidEntries.length < 20)
        invalidEntries.push({
          index: ordinal,
          reason: "non-string resolved label",
          raw: capture({ entry, label }, 2048),
        });
    }
    const node = summarize(entry, label);
    if (node.toolCallId && source?.ids.has(node.toolCallId)) node.toolAnchor = source.id;
    nodes.push(node);
  }
  return {
    protocol: 1,
    generation,
    revision,
    sessionId: readSessionId(manager),
    ...readSessionName(manager),
    leafId,
    totalEntries: entries.length,
    nodes,
    incomplete: entries.length > 10000 || tools.length > 256 || skills.length > 256 || invalidEntryCount > 0,
    invalidEntryCount,
    invalidEntries,
    context: observedContext ?? sessionContext(manager, index),
    cache: cacheHistory(manager, index, resolveCostModel),
    currentPrompt: capture(prompt, 65536),
    tools: projectToolCatalog(tools, active),
    skills: skills.slice(0, 256).map((s) => ({
      name: displayText(s.name).slice(0, 512),
      path: displayText(s.path).slice(0, 2048),
      pathTruncated: displayText(s.path).length > 2048,
      description: displayText(s.description).slice(0, 512),
      metadataTruncated:
        displayText(s.name).length > 512 ||
        displayText(s.path).length > 2048 ||
        displayText(s.description).length > 512,
    })),
    calls: collector.list(),
    droppedCalls: collector.dropped,
    invalidCallEvents: collector.invalidEvents,
    captureStartedAt: collector.startedAt,
  };
}

export function branch(
  manager: ReadonlySessionManager,
  leafId: string,
  offset: number,
  skills: SkillView[],
  index = new EntryIndex(manager.getEntries()),
): BranchView {
  if (!index.byId.has(leafId)) throw new Error("Unknown entry");
  const walked = ancestry(manager, leafId, index);
  const { path } = walked;
  const projection = walked.issue ? undefined : buildSessionProjection(path, leafId);
  const target = index.get(leafId);
  const previousView = !walked.issue && target?.parentId ? nativeProjection(path, target.parentId) : undefined;
  const previous = previousView?.projection?.messages ?? [];
  const issue = walked.issue ?? (projection && systemReplayIssue(projection.messages)) ?? systemReplayIssue(previous);
  if (issue || !projection) {
    const unavailable = capture(`[unavailable: ${issue}]`);
    return {
      leafId,
      ancestryIssue: issue,
      entries: path
        .slice(offset, offset + 50)
        .filter((entry) => !identityIssue(entry))
        .map((entry) => summarize(entry, manager.getLabel(entry.id))),
      total: path.length,
      offset,
      prompt: unavailable,
      previousPrompt: unavailable,
      sections: unavailable,
      declaredTools: unavailable,
      promptUpdates: unavailable,
      projection: unavailable,
      context: {
        source: "session-derived",
        leafId,
        totalMessages: 0,
        messages: [],
        segments: [],
        incomplete: true,
        unavailable: issue,
      },
      skillEvidence: unavailable,
    };
  }
  const historicalSystem = getCurrentSystemMessage(projection.messages);
  const evidence: { name: string; state: string; entryId: string }[] = [];
  const callPaths = new Map<string, string>();
  const byPath = new Map(skills.map((skill) => [skill.path, skill]));
  let scanned = 0;
  let evidenceIncomplete = false;
  function spend(): boolean {
    if (++scanned <= 2048 && evidence.length < 256) return true;
    evidenceIncomplete = true;
    return false;
  }
  evidenceLoop: for (const entry of path) {
    if (identityIssue(entry)) continue;
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "assistant") {
      callPaths.clear();
      const duplicateIds = new Set<string>();
      const encountered = new Set<string>();
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (!spend()) break evidenceLoop;
        if (block.type === "toolCall") {
          if (encountered.has(block.id)) duplicateIds.add(block.id);
          encountered.add(block.id);
        }
        if (
          block.type === "toolCall" &&
          block.name === "read" &&
          typeof block.arguments?.path === "string" &&
          block.arguments.path.length <= 8192
        ) {
          callPaths.set(block.id, block.arguments.path);
        }
      }
      for (const id of duplicateIds) callPaths.delete(id);
    }
    if (m.role === "user" && typeof m.content === "string") {
      if (!spend()) break;
      if (m.content.length > 8192) {
        evidenceIncomplete = true;
        continue;
      }
      const invoked = parseSkillBlock(m.content);
      if (invoked) evidence.push({ name: invoked.name, state: "explicitly invoked", entryId: entry.id });
    }
    if (m.role === "toolResult" && m.isError === false) {
      if (!spend()) break;
      const path = callPaths.get(m.toolCallId);
      const skill = path ? byPath.get(path) : undefined;
      if (skill) evidence.push({ name: skill.name, state: "successfully read", entryId: entry.id });
      // Public bounded nested metadata provides names/arguments/status, never child results.
      for (const call of Array.isArray(m.nestedCalls?.calls) ? m.nestedCalls.calls : []) {
        if (!spend()) break evidenceLoop;
        if (!call || typeof call !== "object" || call.name !== "read" || call.status !== "ok") continue;
        const nestedPath = call.arguments?.path;
        const skill = typeof nestedPath === "string" && nestedPath.length <= 8192 ? byPath.get(nestedPath) : undefined;
        if (skill) {
          evidence.push({ name: skill.name, state: "successfully read (nested metadata)", entryId: entry.id });
        }
      }
    }
  }
  const capturedEvidence = capture(evidence);
  capturedEvidence.truncated ||= evidenceIncomplete;
  return {
    leafId,
    entries: path
      .slice(offset, offset + 50)
      .filter((entry) => !identityIssue(entry))
      .map((e) => summarize(e, manager.getLabel(e.id))),
    total: path.length,
    offset,
    prompt: capture(
      historicalSystem ? getCurrentSystemPrompt(projection.messages) : "[unavailable: no stored system prompt]",
      65536,
    ),
    previousPrompt: capture(
      previousView?.issue
        ? `[unavailable: ${previousView.issue}]`
        : getCurrentSystemMessage(previous)
          ? getCurrentSystemPrompt(previous)
          : "[unavailable: no stored system prompt]",
      65536,
    ),
    sections: capture(historicalSystem?.sections),
    declaredTools: capture(
      getInitialSystemMessage(projection.messages)
        ? getCurrentTools(projection.messages).map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          }))
        : "[unavailable: no initial system/tool checkpoint]",
    ),
    promptUpdates: capture(
      path
        .filter((e) => e.type === "message" && e.message.role === "system")
        .map((e) => ({ id: e.id, message: e.type === "message" ? e.message : null })),
    ),
    projection: capture(
      projection.entries.map((e) => ({ id: e.sourceEntry.id, messages: e.messages })),
      65536,
    ),
    context: captureContext(projection.messages, "session-derived", leafId),
    skillEvidence: capturedEvidence,
  };
}

export function detail(
  manager: ReadonlySessionManager,
  id: string,
  leafId: string,
  collector: Collector,
  index = new EntryIndex(manager.getEntries()),
): DetailView {
  if (index.duplicates.has(id) || index.duplicates.has(leafId)) throw new Error("Ambiguous duplicate entry id");
  const entry = index.get(id);
  if (!entry || !index.get(leafId)) throw new Error("Unknown entry");
  const selected = ancestry(manager, id, index);
  const leaf = id === leafId ? selected : ancestry(manager, leafId, index);
  const issue = selected.issue ?? leaf.issue;
  if (issue)
    return {
      ancestryIssue: issue,
      raw: capture(entry, 65536),
      projected: capture(`[unavailable: ${issue}]`),
      calls: [],
    };
  const projected = buildSessionProjection(leaf.path, leafId).entries.find((e) => e.sourceEntry.id === id);
  const ids = new Set<string>();
  if (entry.type === "message") {
    const m = entry.message;
    if (m.role === "assistant" && !identityIssue(entry))
      for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === "toolCall") ids.add(b.id);
    if (m.role === "toolResult") ids.add(m.toolCallId);
  }
  const toolAnchor =
    entry.type === "message" && entry.message.role === "assistant"
      ? entry.id
      : selected.path
          .slice()
          .reverse()
          .find(
            (candidate) =>
              candidate.type === "message" &&
              !identityIssue(candidate) &&
              candidate.message.role === "assistant" &&
              (Array.isArray(candidate.message.content) ? candidate.message.content : []).some(
                (block) => block.type === "toolCall" && ids.has(block.id),
              ),
          )?.id;
  return {
    toolAnchor,
    raw: capture(entry, 65536),
    projected: capture(projected?.messages),
    calls: correlatedCalls(ids, toolAnchor, collector.list()),
  };
}
