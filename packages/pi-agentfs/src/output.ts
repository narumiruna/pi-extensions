import { truncateHead } from "@earendil-works/pi-coding-agent";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;

/** Reserve space for the notice so the complete returned text stays within Pi's limits. */
export function boundedText(text: string): string {
  if (!truncateHead(text).truncated) return text;
  const result = truncateHead(text, { maxBytes: MAX_OUTPUT_BYTES - 128, maxLines: MAX_OUTPUT_LINES - 2 });
  return result.truncated ? `${result.content}\n[Output truncated; excess output was discarded.]` : text;
}
