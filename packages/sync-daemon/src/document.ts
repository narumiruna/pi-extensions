import { createHash } from "node:crypto";

export interface DocumentView {
  path: string;
  bytes: string;
  identity: { dev: number; ino: number };
  parsed: Record<string, unknown>;
}
export function documentFingerprint(document: Pick<DocumentView, "bytes" | "identity"> | undefined) {
  return document
    ? createHash("sha256").update(document.bytes).update(JSON.stringify(document.identity)).digest("hex")
    : null;
}
