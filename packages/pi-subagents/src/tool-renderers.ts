import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  asRecord,
  type ConversationResult,
  conversationView,
  displayDocument,
  displayHeading,
  displayJson,
  displayLine,
  expansionHint,
  jobBody,
  jobPayload,
  jobSummary,
  parseRecord,
  stateLabel,
  textContent,
} from "./conversation-view.js";
import { JOB_STATES } from "./types.js";

export type SubagentToolAction = "spawn" | "inspect" | "cancel" | "wait" | "send";

const LABELS = { spawn: "Spawn", inspect: "Inspect", cancel: "Cancel", wait: "Wait", send: "Send" } as const;
const PENDING = {
  spawn: "Starting subagent…",
  inspect: "Inspecting jobs…",
  cancel: "Cancelling job…",
  wait: "Waiting for job or subagent message…",
  send: "Sending message…",
} as const;
const INSPECT_PREVIEW_JOBS = 5;
const STATE_PRIORITY = { failed: 0, timed_out: 1, partial: 2, running: 3, queued: 4, cancelled: 5, completed: 6 };

// Pi owns the default shell. Its minimum content cell and padding can exceed a
// viewport narrower than three cells; these renderers bound their inner content.
export function subagentToolRenderers(action: SubagentToolAction): ToolRenderers {
  return {
    renderCall(input, theme, context) {
      const args = asRecord(input) ?? {};
      const target =
        action === "send"
          ? typeof args.requestId === "string"
            ? `reply to ${args.requestId}`
            : typeof args.recipient === "string"
              ? `to ${args.recipient}`
              : ""
          : typeof args.jobId === "string"
            ? args.jobId
            : "";
      const children = [displayHeading(theme, `Subagent · ${LABELS[action]}`, target)];
      if (context.expanded) {
        for (const [key, value] of Object.entries(args)) {
          if (typeof value === "string") {
            children.push(displayDocument(theme, `${key}: ${value}`, "muted"));
          } else if (value !== undefined) {
            children.push(displayLine(theme, `${key}:`, "muted"), displayJson(theme, value));
          }
        }
      } else {
        const preview = action === "spawn" ? args.task : action === "send" ? args.message : undefined;
        if (typeof preview === "string") children.push(displayLine(theme, preview, "muted"));
      }
      return conversationView(children);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const raw = textContent(result.content);
      const children: Component[] = [];
      if (context.isError) {
        children.push(
          displayLine(theme, `${LABELS[action]} failed`, "error"),
          expanded ? displayDocument(theme, raw, "error") : displayLine(theme, raw, "error"),
        );
      } else if (isPartial) {
        return displayLine(theme, PENDING[action], "muted");
      } else {
        const payload = toolPayload(action, result);
        if (!payload) {
          children.push(
            expanded
              ? displayDocument(theme, raw || "No result returned.")
              : displayLine(theme, raw || "No result returned."),
          );
        } else if (action === "inspect") {
          children.push(...inspectSummary(theme, payload, expanded));
          if (expanded) children.push(displayJson(theme, payload));
        } else if (action === "send") {
          const accepted = payload.accepted === true;
          const reply = typeof asRecord(context.args)?.requestId === "string";
          children.push(
            displayLine(
              theme,
              `${reply ? "Reply" : "Request"} ${accepted ? "accepted" : "not accepted"}${payload.duplicate === true ? " · duplicate" : ""} · ${payload.requestId}`,
              accepted ? "success" : "warning",
            ),
          );
          if (expanded) children.push(displayJson(theme, payload));
        } else {
          const job = jobPayload(payload);
          if (job) children.push(jobSummary(theme, job));
          if (expanded) {
            if (action === "wait" && job) {
              const { result: _result, error: _error, limitations: _limitations, ...metadata } = job;
              children.push(displayJson(theme, metadata), jobBody(theme, job));
            } else {
              children.push(displayJson(theme, payload));
            }
          }
        }
      }
      if (!expanded) children.push(expansionHint(theme, context));
      return conversationView(children);
    },
  };
}

function toolPayload(action: SubagentToolAction, result: ConversationResult): Record<string, unknown> | undefined {
  for (const value of [result.details, parseRecord(textContent(result.content))]) {
    const record = asRecord(value);
    if (!record) continue;
    if (action === "inspect") {
      if (Array.isArray(record.jobs) && record.jobs.every((job) => jobPayload(job))) return record;
    } else if (action === "send") {
      if (typeof record.requestId === "string" && typeof record.accepted === "boolean") return record;
    } else if (jobPayload(record)) {
      return record;
    }
  }
  return undefined;
}

function inspectSummary(theme: Theme, payload: Record<string, unknown>, expanded: boolean): Component[] {
  const jobs = (payload.jobs as unknown[]).map(jobPayload).filter((job) => job !== undefined);
  const counts = JOB_STATES.map((state) => {
    const count = jobs.filter((job) => job.state === state).length;
    return count ? `${count} ${stateLabel(state)}` : undefined;
  }).filter(Boolean);
  const children = [
    displayLine(
      theme,
      jobs.length ? `${jobs.length} job${jobs.length === 1 ? "" : "s"} · ${counts.join(" · ")}` : "No retained jobs.",
      "muted",
    ),
  ];
  if (!expanded) {
    const sorted = [...jobs].sort((left, right) => STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state]);
    for (const job of sorted.slice(0, INSPECT_PREVIEW_JOBS)) children.push(jobSummary(theme, job));
    if (jobs.length > INSPECT_PREVIEW_JOBS) {
      children.push(displayLine(theme, `${jobs.length - INSPECT_PREVIEW_JOBS} more jobs`, "muted"));
    }
  }
  const omitted = asRecord(payload.omitted)?.jobs;
  if (typeof omitted === "number" && omitted > 0) {
    children.push(displayLine(theme, `${omitted} expired or removed jobs not retained`, "muted"));
  }
  return children;
}
