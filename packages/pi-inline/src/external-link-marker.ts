import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";
import type { classifyLinkPath } from "./filelinks.js";

// Match Pi's OSC 8 parameters, URL, and terminator without changing cell widths.
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 uses ESC and BEL.
const OSC_8 = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(\x07|\x1b\\)/g;

const FILE_ID = "id=pi-inline-file-";
const OPEN = "\x1b]8;;";

type LocalTarget = NonNullable<ReturnType<typeof classifyLinkPath>>;
type MarkedFile = LocalTarget & { originalHref: string; clickUrl: string };

export function createLinkMarker() {
  const key = randomBytes(32);
  const id = (href: string) => createHmac("sha256", key).update(href).digest("hex");
  const files = new Map<string, MarkedFile>();
  return {
    mark(text: string, href: string, target: LocalTarget): string {
      if (!text.startsWith(OPEN)) return text;
      const hash = href.indexOf("#");
      if (
        hash >= 0 &&
        hash < href.length - 1 &&
        !href.slice(0, hash).includes("?") &&
        href.isWellFormed() &&
        target.path.isWellFormed()
      ) {
        const params = FILE_ID + id(href);
        let file = files.get(params);
        if (!file) {
          file = { ...target, originalHref: href, clickUrl: pathToFileURL(target.path).href };
          files.set(params, file);
        }
        return `\x1b]8;${params};${file.clickUrl}${text.slice(OPEN.length + href.length)}`;
      }
      return target.kind === "external" ? `\x1b]8;id=pi-inline-external-${id(href)};${text.slice(OPEN.length)}` : text;
    },
    findFile(line: string, column: number, href: string): MarkedFile | null | undefined {
      if (!line.includes(FILE_ID)) return undefined;
      const marked = line.replace(OSC_8, (_sequence, params: string, url: string, end: string) => {
        const file = files.get(params);
        const token =
          file && file.clickUrl === url && url === href ? params : params.startsWith(FILE_ID) ? "invalid" : "";
        return `${OPEN}${token}${end}`;
      });
      const params = getOsc8LinkAtColumn(marked, column);
      return params ? (files.get(params) ?? null) : undefined;
    },
    matchesExternal(line: string, column: number, href: string): boolean {
      const expected = `id=pi-inline-external-${id(href)}`;
      const marked = line.replace(OSC_8, (sequence, params: string, url: string, end: string) =>
        params === expected && url === href ? sequence : `\x1b]8;;${end}`,
      );
      return getOsc8LinkAtColumn(marked, column) === href;
    },
    clear() {
      files.clear();
    },
  };
}
