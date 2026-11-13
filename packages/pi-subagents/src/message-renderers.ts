import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";
import {
  asRecord,
  boundedView,
  displayDocument,
  displayHeading,
  displayLine,
  expansionHint,
  jobBody,
  jobPayload,
  jobSummary,
  parseRecord,
  textContent,
} from "./conversation-view.js";

export const COMPLETION_MESSAGE_TYPE = "pi-subagents-completion";
export const BROKER_MESSAGE_TYPE = "pi-subagents-message";
const COMPLETION_PREFIX = "Subagent job completion:\n";

type BrokerDetails = { kind: "request" | "response"; jobId: string; requestId: string };

function brokerDetails(value: unknown): BrokerDetails | undefined {
  const details = asRecord(value);
  return details &&
    (details.kind === "request" || details.kind === "response") &&
    typeof details.jobId === "string" &&
    typeof details.requestId === "string"
    ? (details as BrokerDetails)
    : undefined;
}

function legacyBrokerDetails(content: string): BrokerDetails | undefined {
  const [type, protocol, request, job] = content.split("\n", 4);
  if (
    protocol !== "Protocol: pi-subagents:main-message:v1" ||
    !request?.startsWith("Request ID: ") ||
    !job?.startsWith("Job ID: ")
  )
    return undefined;
  const kind =
    type === "Message Type: SUBAGENT_REQUEST"
      ? "request"
      : type === "Message Type: SUBAGENT_RESPONSE"
        ? "response"
        : undefined;
  return brokerDetails({ kind, requestId: request.slice("Request ID: ".length), jobId: job.slice("Job ID: ".length) });
}

function createMessageBox(children: Component[], outputPad: number, background: (text: string) => string): Component {
  return boundedView(
    (width) => {
      const padding = Number.isFinite(outputPad) ? Math.max(0, Math.floor(outputPad)) : 0;
      const box = new Box(Math.min(padding, Math.floor((width - 1) / 2)), 1, background);
      for (const child of children) box.addChild(child);
      return box.render(width);
    },
    () => {
      for (const child of children) child.invalidate();
    },
  );
}

export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, (message, options, theme) => {
    const content = textContent(message.content);
    const payload =
      jobPayload(message.details) ??
      jobPayload(
        parseRecord(content.startsWith(COMPLETION_PREFIX) ? content.slice(COMPLETION_PREFIX.length) : content),
      );
    const children = [displayHeading(theme, "Subagent job completion", "", "customMessageLabel")];
    if (payload) children.push(jobSummary(theme, payload));
    if (options.expanded) {
      children.push(payload ? jobBody(theme, payload) : displayDocument(theme, content, "customMessageText"));
    } else {
      children.push(expansionHint(theme, options));
    }
    return createMessageBox(children, options.outputPad, (text) => theme.bg("customMessageBg", text));
  });

  pi.registerMessageRenderer(BROKER_MESSAGE_TYPE, (message, options, theme) => {
    const content = textContent(message.content);
    const details = brokerDetails(message.details) ?? legacyBrokerDetails(content);
    const title = details ? `Subagent ${details.kind}` : "Subagent message";
    const source = details ? `from ${details.jobId}` : "";
    const children = [displayHeading(theme, title, source, "customMessageLabel")];
    if (details) {
      children.push(
        displayLine(
          theme,
          `${details.requestId} · ${details.kind === "request" ? "needs reply" : "response received"}`,
          "muted",
        ),
      );
    }
    if (options.expanded) {
      children.push(displayDocument(theme, content, "customMessageText"));
    } else {
      children.push(expansionHint(theme, options));
    }
    return createMessageBox(children, options.outputPad, (text) => theme.bg("customMessageBg", text));
  });
}
