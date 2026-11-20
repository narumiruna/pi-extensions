import { createHmac, randomBytes } from "node:crypto";
import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";

// Match Pi's OSC 8 parameters, URL, and terminator without changing cell widths.
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 uses ESC and BEL.
const OSC_8 = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(\x07|\x1b\\)/g;

/** Proves that an external hover target came from this session's Markdown renderer. */
export function createExternalLinkMarker() {
  const key = randomBytes(32);
  const id = (href: string) => `id=pi-inline-external-${createHmac("sha256", key).update(href).digest("hex")}`;
  return {
    mark(text: string, href: string): string {
      // Set OSC 8 metadata, not the click destination.
      return text.startsWith("\x1b]8;;") ? text.replace("\x1b]8;;", `\x1b]8;${id(href)};`) : text;
    },
    matches(line: string, column: number, href: string): boolean {
      const expected = id(href);
      const marked = line.replace(OSC_8, (sequence, params: string, url: string, end: string) =>
        params === expected && url === href ? sequence : `\x1b]8;;${end}`,
      );
      return getOsc8LinkAtColumn(marked, column) === href;
    },
  };
}
