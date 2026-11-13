import type { Theme, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { hardWrapTerminalDocument, sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";

interface WaitRenderResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface WaitRenderDetails {
  reason: string;
  goal_id: string;
  goal?: string;
  resume_at?: number;
  requested_resume_after_ms?: number;
  resume_after_ms?: number;
}

type WaitRenderContext = Partial<
  Pick<Parameters<NonNullable<ToolRenderers["renderResult"]>>[3], "keyText" | "keyHint" | "isError">
>;

export function renderGoalWaitCall(_args: unknown, theme: Theme): Component {
  return {
    render: (width) =>
      Number.isFinite(width) && width >= 1
        ? [truncateToWidth(theme.fg("toolTitle", theme.bold("Goal Wait")), Math.floor(width), "…")]
        : [],
    invalidate() {},
  };
}

export function renderGoalWaitResult(
  result: WaitRenderResult,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
  context: WaitRenderContext = {},
): Component {
  const textBlocks = result.content.filter((block) => block.type === "text" && typeof block.text === "string");
  const text = textBlocks
    .map((block) => block.text)
    .join("\n")
    .trim();
  // Rejected calls also have wait details. Only a finalized accepted result can use them.
  const details =
    !isPartial && !context.isError && textBlocks.length === 1 && text.startsWith("Goal waiting:")
      ? readWaitDetails(result.details)
      : undefined;

  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      const safeWidth = Math.floor(width);
      const body = hardWrapTerminalDocument(details?.reason ?? text, safeWidth);
      const clipped = !expanded && body.length > 2;
      const shown = clipped ? body.slice(0, 2) : body;
      if (clipped) shown[1] = `${truncateToWidth(shown[1] ?? "", safeWidth - 1, "")}…`;
      const role = context.isError || text.startsWith("goal_wait rejected:") ? "warning" : "toolOutput";
      const lines = shown.map((line) => theme.fg(role, line));
      const secondary = (value: string) => {
        lines.push(...hardWrapTerminalDocument(value, safeWidth).map((line) => theme.fg("muted", line)));
      };

      if (details) {
        if (expanded) {
          if (details.goal) secondary(`Goal: ${details.goal}`);
          secondary(`Goal ID: ${details.goal_id}`);
        }
        if (details.resume_at !== undefined) secondary(`Safety wake: ${new Date(details.resume_at).toISOString()}`);
        secondary("Resume: external input or /goal resume");
        if (expanded && details.requested_resume_after_ms !== undefined) {
          secondary(`Requested delay: ${details.requested_resume_after_ms} ms`);
          if (details.resume_after_ms !== undefined) secondary(`Effective delay: ${details.resume_after_ms} ms`);
        }
      }

      if (!expanded && (details || clipped) && context.keyText?.("app.tools.expand") && context.keyHint) {
        secondary(context.keyHint("app.tools.expand", "to expand"));
      }
      return lines;
    },
    // Theme roles are evaluated on every render; there is no themed cache to clear.
    invalidate() {},
  };
}

function readWaitDetails(value: unknown): WaitRenderDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as WaitRenderDetails;
  if (typeof details.reason !== "string" || !details.reason.trim()) return undefined;
  if (typeof details.goal_id !== "string" || !details.goal_id.trim()) return undefined;
  if (details.goal !== undefined && typeof details.goal !== "string") return undefined;
  if (
    details.resume_at !== undefined &&
    (!Number.isSafeInteger(details.resume_at) || details.resume_at < 0 || details.resume_at > 8_640_000_000_000_000)
  ) {
    return undefined;
  }
  for (const delay of [details.requested_resume_after_ms, details.resume_after_ms]) {
    if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 1)) return undefined;
  }
  return {
    ...details,
    reason: sanitizeTerminalDocument(details.reason),
  };
}
