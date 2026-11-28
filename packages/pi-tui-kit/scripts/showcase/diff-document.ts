import { createRequire } from "node:module";

const requireFromKit = createRequire(import.meta.resolve("@narumitw/pi-tui-kit"));
const { createTwoFilesPatch, FILE_HEADERS_ONLY } = requireFromKit("diff") as typeof import("diff");

const MAX_DIFF_BYTES = 64 * 1024;
const MAX_EDIT_LENGTH = 1_024;
const DIFF_TIMEOUT_MS = 50;

export function prepareDiffDocument(before: string, after: string): { content: string; kind: "diff" | "text" } {
  const tooLarge = { kind: "text", content: "Comparison exceeds the preview limit." } as const;
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > MAX_DIFF_BYTES) return tooLarge;
  if (before === after) return { kind: "text", content: "No differences." };

  const patch = createTwoFilesPatch("a/settings.toml", "b/settings.toml", before, after, undefined, undefined, {
    context: 3,
    headerOptions: FILE_HEADERS_ONLY,
    maxEditLength: MAX_EDIT_LENGTH,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (patch === undefined || Buffer.byteLength(patch) > MAX_DIFF_BYTES) return tooLarge;
  return { kind: "diff", content: patch.endsWith("\n") ? patch.slice(0, -1) : patch };
}
