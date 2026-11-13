import { getMarkdownTheme, type KeybindingHints, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { hardWrapTerminalDocument, sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { JOB_STATES, type SubagentJobState } from "./types.js";

export interface ConversationResult {
  content: readonly { type: string; text?: string }[];
  details?: unknown;
}

export type JobPayload = Record<string, unknown> & { jobId: string; state: SubagentJobState };

export function boundedView(render: (width: number) => string[], invalidate: () => void = () => {}): Component {
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      const columns = Math.floor(width);
      return render(columns).map((line) => truncateToWidth(line, columns, ""));
    },
    invalidate,
  };
}

export function conversationView(children: Component[]): Component {
  return boundedView(
    (width) => children.flatMap((child) => child.render(width)),
    () => {
      for (const child of children) child.invalidate();
    },
  );
}

function singleLine(text: string): string {
  return sanitizeTerminalDocument(text).replace(/\s+/gu, " ").trim();
}

export function displayLine(theme: Theme, text: string, role: ThemeColor = "toolOutput"): Component {
  const safe = singleLine(text);
  return boundedView((width) => [theme.fg(role, truncateToWidth(safe, width, "…"))]);
}

export function displayHeading(theme: Theme, title: string, detail = "", role: ThemeColor = "toolTitle"): Component {
  const safeTitle = singleLine(title);
  const safeDetail = singleLine(detail);
  return boundedView((width) => [
    truncateToWidth(
      theme.fg(role, theme.bold(safeTitle)) + (safeDetail ? theme.fg("muted", ` · ${safeDetail}`) : ""),
      width,
      "…",
    ),
  ]);
}

export function displayDocument(theme: Theme, text: string, role: ThemeColor = "toolOutput"): Component {
  const safe = sanitizeTerminalDocument(text);
  return boundedView((width) => hardWrapTerminalDocument(safe, width).map((line) => theme.fg(role, line)));
}

export function displayJson(theme: Theme, value: unknown): Component {
  const text = JSON.stringify(
    value,
    (_key, item) => (typeof item === "string" ? sanitizeTerminalDocument(item) : item),
    2,
  );
  return displayDocument(theme, text ?? "");
}

export function displayMarkdown(theme: Theme, text: string, role: ThemeColor = "toolOutput"): Component {
  const safe = sanitizeTerminalDocument(text);
  const markdown = new Markdown(safe, 0, 0, getMarkdownTheme(), { color: (value) => theme.fg(role, value) });
  return boundedView(
    (width) => markdown.render(width),
    () => markdown.invalidate(),
  );
}

export function expansionHint(theme: Theme, hints: Partial<KeybindingHints>): Component {
  const key = hints.keyText?.("app.tools.expand");
  return conversationView(key ? [displayLine(theme, `(${key} to expand)`, "muted")] : []);
}

export function textContent(content: string | ConversationResult["content"]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function jobPayload(value: unknown): JobPayload | undefined {
  const record = asRecord(value);
  if (!record || typeof record.jobId !== "string" || !JOB_STATES.some((state) => state === record.state))
    return undefined;
  if (["result", "error"].some((key) => record[key] !== undefined && typeof record[key] !== "string")) return undefined;
  if (
    record.limitations !== undefined &&
    (!Array.isArray(record.limitations) || record.limitations.some((value) => typeof value !== "string"))
  )
    return undefined;
  if (["timedOut", "interrupted"].some((key) => record[key] !== undefined && typeof record[key] !== "boolean"))
    return undefined;
  return record as JobPayload;
}

export function stateLabel(state: SubagentJobState): string {
  return state === "timed_out" ? "timed out" : state;
}

export function stateRole(state: SubagentJobState): ThemeColor {
  switch (state) {
    case "completed":
      return "success";
    case "failed":
    case "timed_out":
      return "error";
    case "partial":
    case "cancelled":
      return "warning";
    case "running":
      return "accent";
    case "queued":
      return "muted";
  }
}

export function jobSummary(theme: Theme, payload: JobPayload): Component {
  const waitStatus = payload.timedOut === true ? " · wait timed out (job not cancelled)" : "";
  const interrupted = payload.interrupted === true ? " · interrupted by subagent message" : "";
  const error = typeof payload.error === "string" && payload.error ? ` · ${payload.error}` : "";
  const limitations = Array.isArray(payload.limitations) ? payload.limitations.length : 0;
  return displayLine(
    theme,
    `${payload.jobId} · ${stateLabel(payload.state)}${waitStatus}${interrupted}${error}${limitations ? ` · ${limitations} limitation${limitations === 1 ? "" : "s"}` : ""}`,
    payload.state === "failed" || payload.state === "timed_out"
      ? "error"
      : payload.timedOut === true || payload.interrupted === true
        ? "warning"
        : stateRole(payload.state),
  );
}

export function jobBody(theme: Theme, payload: JobPayload): Component {
  const children: Component[] = [];
  if (typeof payload.error === "string" && payload.error) {
    children.push(displayDocument(theme, `Error: ${payload.error}`, "error"));
  }
  if (Array.isArray(payload.limitations)) {
    for (const limitation of payload.limitations) {
      if (typeof limitation === "string") children.push(displayDocument(theme, `Limitation: ${limitation}`, "warning"));
    }
  }
  if (typeof payload.result === "string" && payload.result) children.push(displayMarkdown(theme, payload.result));
  return conversationView(children);
}
