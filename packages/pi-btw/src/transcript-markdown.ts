import type { MarkdownTransformer, Theme } from "@earendil-works/pi-coding-agent";
import type { SideTranscriptItem } from "./side-thread.js";

export type BtwMarkdownTransformers = (theme: Theme) => readonly MarkdownTransformer[];

type MermaidMarkdownModule = typeof import("@narumitw/pi-tui-kit/markdown");

const MERMAID_MARKDOWN_MODULE = "@narumitw/pi-tui-kit/markdown";
const noMarkdownTransformers: BtwMarkdownTransformers = () => [];

export function prepareBtwTranscriptMarkdown(
  turns: readonly SideTranscriptItem[],
  pendingQuestion?: string,
): Promise<BtwMarkdownTransformers>;
export function prepareBtwTranscriptMarkdown(
  turns: readonly SideTranscriptItem[],
  pendingQuestion: string | undefined,
  signal: AbortSignal,
): Promise<BtwMarkdownTransformers | undefined>;
export async function prepareBtwTranscriptMarkdown(
  turns: readonly SideTranscriptItem[],
  pendingQuestion?: string,
  signal?: AbortSignal,
): Promise<BtwMarkdownTransformers | undefined> {
  const documents = turns.flatMap((turn) =>
    turn.kind === "mainContext" ? [] : turn.kind === "answered" ? [turn.question, turn.answer] : [turn.question],
  );
  if (pendingQuestion) documents.push(pendingQuestion);
  if (!documents.some((document) => /mermaid/iu.test(document))) return noMarkdownTransformers;
  if (signal?.aborted) return undefined;

  const markdownModule = await settleUnlessAborted(
    import(MERMAID_MARKDOWN_MODULE) as Promise<MermaidMarkdownModule>,
    signal,
  );
  if (!markdownModule || signal?.aborted) return undefined;
  const { createMermaidMarkdownTransformer, prepareMermaidMarkdownRenderer } = markdownModule;
  const preparations = new Set<Promise<void>>();
  for (const document of documents) {
    const preparation = prepareMermaidMarkdownRenderer(document);
    if (preparation) preparations.add(preparation);
  }
  if (preparations.size > 0 && !(await settleUnlessAborted(Promise.all(preparations), signal))) return undefined;
  if (signal?.aborted) return undefined;

  return (theme) => {
    const transformer = createMermaidMarkdownTransformer(theme);
    return transformer ? [transformer] : [];
  };
}

async function settleUnlessAborted<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return operation;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
