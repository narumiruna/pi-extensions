import { stripVTControlCharacters } from "node:util";

/** Remove only Pi's trusted cursor markers; leave other controls visible to safety assertions. */
export function stripTuiCursorMarkers(text: string): string {
  return text
    .replaceAll("\u001b_pi:c\u0007", "")
    .replaceAll("\u001b_pi:fc\u0007", "")
    .replaceAll("\u001b_pi:/fc\u0007", "");
}

/** Plain component text before the host renderer consumes Pi cursor markers. */
export function plainTuiText(text: string): string {
  return stripVTControlCharacters(stripTuiCursorMarkers(text));
}
