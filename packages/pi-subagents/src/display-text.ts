import { sanitizeTerminalText } from "./message-broker.js";

/** Single-line terminal display only; keep raw tasks, paths, and identifiers unchanged. */
export function sanitizeSubagentDisplayText(value: string): string {
  // Bound sequence bodies at another control introducer to keep malformed input linear.
  const text = value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip untrusted terminal sequences before display.
    /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u0080-\u009f]*(?:\u0007|\u001b\\|\u009c)|\u001b[ -/]*[0-~]/gu,
    "",
  );
  return sanitizeTerminalText(text.replace(/\p{Bidi_Control}/gu, ""))
    .replace(/\s+/gu, " ")
    .trim();
}
