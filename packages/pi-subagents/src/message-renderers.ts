import { type ExtensionAPI, getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./message-broker.js";

export const COMPLETION_MESSAGE_TYPE = "pi-subagents-completion";
export const BROKER_MESSAGE_TYPE = "pi-subagents-message";

function createMessageBox(children: Component[], outputPad: number, background: (text: string) => string): Component {
  return {
    render(width) {
      if (width <= 0) return [];
      const maxPadding = Math.floor((width - 1) / 2);
      const box = new Box(Math.min(Math.max(0, outputPad), maxPadding), 1, background);
      for (const child of children) box.addChild(child);
      return box.render(width);
    },
    invalidate() {
      for (const child of children) child.invalidate();
    },
  };
}

export function registerMessageRenderers(pi: ExtensionAPI): void {
  for (const [messageType, summary] of [
    [COMPLETION_MESSAGE_TYPE, "Subagent job completion"],
    [BROKER_MESSAGE_TYPE, "Subagent message"],
  ] as const) {
    pi.registerMessageRenderer(messageType, (message, options, theme) => {
      const children: Component[] = [
        new Text(theme.fg("customMessageLabel", theme.bold(`[${messageType}]`)), 0, 0),
        new Spacer(1),
      ];
      if (!options.expanded) {
        children.push(
          new Text(
            theme.fg("customMessageText", `${summary} (`) +
              theme.fg("dim", keyText("app.tools.expand")) +
              theme.fg("customMessageText", " to expand)"),
            0,
            0,
          ),
        );
      } else {
        const content =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        children.push(
          new Markdown(sanitizeTerminalText(content), 0, 0, getMarkdownTheme(), {
            color: (text) => theme.fg("customMessageText", text),
          }),
        );
      }
      return createMessageBox(children, options.outputPad, (text) => theme.bg("customMessageBg", text));
    });
  }
}
