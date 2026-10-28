import type { ReadOperations, ReadToolDetails, ReadToolInput } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "./output.js";
import { virtualRenderers } from "./renderers.js";

/** Pi's resolver probes the host before ReadOperations. Use only its schema and
 * truncation helpers, never its execute method. Images and host filename guesses are omitted. */
export function createVirtualRead(operations: ReadOperations): ReturnType<typeof createReadToolDefinition> {
  const core = createReadToolDefinition("/", { operations });
  return {
    ...core,
    ...virtualRenderers("read"),
    description:
      "Read a text file in AgentFS. Paths are relative to virtual /. Use offset (1-indexed) and limit for paged reads. Output is limited to 50 KB or 2,000 lines. Images are not supported.",
    async execute(_id: string, { path, offset, limit }: ReadToolInput, signal?: AbortSignal) {
      const check = () => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };
      for (const [name, value] of [
        ["offset", offset],
        ["limit", limit],
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
          throw new Error(`${name} must be a positive integer.`);
        }
      }
      check();
      await operations.access(path);
      check();
      const buffer = await operations.readFile(path);
      check();
      const lines = buffer.toString("utf-8").split("\n");
      const start = (offset ?? 1) - 1;
      if (start >= lines.length)
        throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
      const selected = lines.slice(start, limit === undefined ? undefined : start + limit).join("\n");
      const truncation = truncateHead(selected, { maxBytes: MAX_OUTPUT_BYTES - 512, maxLines: MAX_OUTPUT_LINES - 3 });
      let text = truncation.content;
      let details: ReadToolDetails | undefined;
      if (truncation.firstLineExceedsLimit) {
        text = `[Line ${start + 1} is ${formatSize(Buffer.byteLength(lines[start], "utf-8"))}, exceeds the text output limit. Use bash with head -c to read a smaller part.]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const end = start + truncation.outputLines;
        text += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
        details = { truncation };
      } else if (limit !== undefined && start + limit < lines.length) {
        text += `\n\n[${lines.length - start - limit} more lines in file. Use offset=${start + limit + 1} to continue.]`;
      }
      return { content: [{ type: "text" as const, text }], details, structuredContent: text };
    },
  };
}
