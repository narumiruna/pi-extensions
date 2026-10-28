import { stripVTControlCharacters } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { hardWrapTerminalDocument } from "@narumitw/pi-tui-kit";

function displayText(text: string): string {
  // Preserve raw tool payloads; strip terminal controls only at the display boundary.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally remove controls, except line feeds and tabs.
  const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
  return stripVTControlCharacters(text).replace(controls, "").replaceAll("\t", "   ");
}

function boundedComponent(text: string, style: (line: string, offset: number) => string, padding = 0): Component {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      const safeWidth = Math.floor(width);
      if (cachedWidth === safeWidth && cachedLines) return cachedLines;
      const marginWidth = Math.min(padding, Math.max(0, Math.floor((safeWidth - 1) / 2)));
      const margin = " ".repeat(marginWidth);
      let offset = 0;
      // Word wrapping trims spaces and hides whitespace-only documents. Wrap sanitized text
      // by display cells first, then apply trusted theme styles to each complete output row.
      cachedLines = hardWrapTerminalDocument(text, safeWidth - marginWidth * 2).map((line) => {
        const rendered = margin + style(line, offset) + margin;
        offset += line.length;
        return rendered;
      });
      cachedWidth = safeWidth;
      return cachedLines;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}

/** Core path renderers link to host files; the edit preview also reads host files. Neither applies
 * to virtual files. Render only supplied text and completed diffs, without speculative I/O. */
export function virtualRenderers(name: string): Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell"> {
  return {
    renderShell: undefined,
    renderCall(input, theme) {
      const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const value = name === "bash" ? args.command : args.path;
      const label = typeof value === "string" ? displayText(value).replaceAll("\n", "\\n") : "...";
      return boundedComponent(`${name} ${label}`, (line, offset) => {
        const titleLength = Math.max(0, name.length - offset);
        return (
          theme.fg("toolTitle", theme.bold(line.slice(0, titleLength))) + theme.fg("accent", line.slice(titleLength))
        );
      });
    },
    renderResult(result, options, theme, context) {
      const details =
        result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
      const raw =
        name === "edit" && !context.isError && typeof details.diff === "string"
          ? details.diff
          : result.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
      const text = displayText(raw);
      const visible = options.expanded ? text : text.split("\n").slice(0, 10).join("\n");
      return boundedComponent(
        visible,
        (line) => theme.fg(context.isError ? "error" : "toolOutput", line),
        context.outputPad,
      );
    },
  };
}
