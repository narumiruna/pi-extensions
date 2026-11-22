import { createHash } from "node:crypto";
import {
  type Callback,
  type ClientFacts,
  type Identity,
  MAX_REVIEW_BYTES,
  REVIEW_PAGE_CHARS,
  record,
} from "./protocol.js";

const SUMMARY_ROWS = 12;
const SUMMARY_ROW_CHARS = 240;
const HASH = /^[a-f0-9]{64}$/u;

interface ReviewScope {
  instance: string;
  client: string;
  generation: string;
  id: string;
  job: string;
}
interface ReviewSummary {
  title: string;
  confirmationLabel?: string;
  summaryLines: readonly string[];
}
interface ReviewBody {
  pages: number;
  bytes: number;
  sha256: string;
}
interface ReviewReference extends ReviewBody {
  offer: string;
}

export function reviewScope(
  identity: Pick<Identity, "instance">,
  facts: Pick<ClientFacts, "id" | "generation">,
  callback: Pick<Callback, "id" | "job">,
): ReviewScope {
  return {
    instance: identity.instance,
    client: facts.id,
    generation: facts.generation,
    id: callback.id,
    job: callback.job,
  };
}

function commitment(scope: ReviewScope, summary: ReviewSummary, body: ReviewBody) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "pi-sync-merge-review-v1",
        scope.instance,
        scope.client,
        scope.generation,
        scope.id,
        scope.job,
        summary.title,
        summary.confirmationLabel ?? null,
        summary.summaryLines,
        body.pages,
        body.bytes,
        body.sha256,
      ]),
    )
    .digest("hex");
}

function exactHash(content: string) {
  return createHash("sha256").update(content, "utf16le").digest("hex");
}

function presentation(
  value: unknown,
): value is Record<string, unknown> & Pick<ReviewSummary, "title" | "confirmationLabel"> {
  return (
    record(value) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= 512 &&
    (value.confirmationLabel === undefined ||
      (typeof value.confirmationLabel === "string" && value.confirmationLabel.length <= 256))
  );
}

export function createPagedReviewOffer(scope: ReviewScope, data: unknown, content: string, bytes: number) {
  if (!presentation(data)) return undefined;
  const supplied = data.summaryLines;
  const candidates =
    Array.isArray(supplied) && supplied.length > 0
      ? supplied.slice(0, SUMMARY_ROWS)
      : content.slice(0, SUMMARY_ROWS * SUMMARY_ROW_CHARS).split("\n", SUMMARY_ROWS);
  const summaryLines = Object.freeze(
    candidates
      .filter((line): line is string => typeof line === "string")
      .map((line) => line.slice(0, SUMMARY_ROW_CHARS)),
  );
  const summary = Object.freeze({ title: data.title, confirmationLabel: data.confirmationLabel, summaryLines });
  const body = { pages: Math.ceil(content.length / REVIEW_PAGE_CHARS), bytes, sha256: exactHash(content) };
  const reference = Object.freeze({ ...body, offer: commitment(scope, summary, body) });
  let nextPage = 0;
  return {
    summary,
    reference,
    generation: scope.generation,
    page(params: Record<string, unknown>) {
      const index = params.index;
      if (
        params.client !== scope.client ||
        params.generation !== scope.generation ||
        params.id !== scope.id ||
        params.offer !== reference.offer ||
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > nextPage ||
        index >= reference.pages
      )
        throw new Error("Stale, foreign, or invalid review page.");
      if (index === nextPage) nextPage++;
      const start = index * REVIEW_PAGE_CHARS;
      return { id: scope.id, index, offer: reference.offer, content: content.slice(start, start + REVIEW_PAGE_CHARS) };
    },
    approved(value: unknown) {
      if (!record(value) || value.approvedReview !== reference.offer || nextPage !== reference.pages)
        throw new Error("Exact review approval did not match the complete current offer.");
      return true;
    },
  };
}

function verifyPagedReview(scope: ReviewScope, payload: unknown, reference: unknown) {
  if (
    !presentation(payload) ||
    payload.content !== undefined ||
    !Array.isArray(payload.summaryLines) ||
    payload.summaryLines.length > SUMMARY_ROWS ||
    !payload.summaryLines.every((line) => typeof line === "string" && line.length <= SUMMARY_ROW_CHARS) ||
    !record(reference) ||
    typeof reference.pages !== "number" ||
    !Number.isSafeInteger(reference.pages) ||
    reference.pages < 1 ||
    reference.pages > Math.ceil(MAX_REVIEW_BYTES / REVIEW_PAGE_CHARS) ||
    typeof reference.bytes !== "number" ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes <= REVIEW_PAGE_CHARS ||
    reference.bytes > MAX_REVIEW_BYTES ||
    typeof reference.sha256 !== "string" ||
    !HASH.test(reference.sha256) ||
    typeof reference.offer !== "string" ||
    !HASH.test(reference.offer)
  )
    throw new Error("Invalid exact-review offer.");
  const summary = Object.freeze({
    title: payload.title,
    confirmationLabel: payload.confirmationLabel,
    summaryLines: Object.freeze([...payload.summaryLines] as string[]),
  });
  const verified = Object.freeze({
    pages: reference.pages,
    bytes: reference.bytes,
    sha256: reference.sha256,
    offer: reference.offer,
  });
  if (commitment(scope, summary, verified) !== verified.offer)
    throw new Error("Exact-review offer changed; approval was refused.");
  return { summary, reference: verified };
}

async function loadPagedReview(
  scope: ReviewScope,
  reference: ReviewReference,
  signal: AbortSignal,
  pageRequest: (params: {
    client: string;
    generation: string;
    id: string;
    offer: string;
    index: number;
  }) => Promise<unknown>,
) {
  const pages: string[] = [];
  const { client, generation, id } = scope;
  for (let index = 0; index < reference.pages; index++) {
    signal.throwIfAborted();
    const page = await pageRequest({ client, generation, id, offer: reference.offer, index });
    signal.throwIfAborted();
    if (
      !record(page) ||
      page.id !== id ||
      page.index !== index ||
      page.offer !== reference.offer ||
      typeof page.content !== "string" ||
      page.content.length < 1 ||
      page.content.length > REVIEW_PAGE_CHARS ||
      (index < reference.pages - 1 && page.content.length !== REVIEW_PAGE_CHARS)
    )
      throw new Error("Invalid exact-review page.");
    pages.push(page.content);
  }
  const content = pages.join("");
  if (Buffer.byteLength(content) !== reference.bytes || exactHash(content) !== reference.sha256)
    throw new Error("Exact-review contents changed; approval was refused.");
  return content;
}

export type MergeReviewPresenter = (
  callback: Callback,
  loadDetails: (signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal,
) => Promise<boolean>;

export async function presentPagedReview(
  scope: ReviewScope,
  callback: Callback,
  signal: AbortSignal,
  present: MergeReviewPresenter,
  requestPage: (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
) {
  if (callback.kind !== "merge-review") throw new Error("Invalid exact-review callback.");
  const { summary, reference } = verifyPagedReview(scope, callback.payload, callback.review);
  const lifetime = new AbortController();
  const owned = AbortSignal.any([signal, lifetime.signal]);
  let loading: Promise<string> | undefined;
  let verified = false;
  try {
    owned.throwIfAborted();
    const approved = await present(
      { ...callback, payload: summary, review: reference },
      (requestSignal) => {
        const pageSignal = requestSignal ? AbortSignal.any([owned, requestSignal]) : owned;
        if (!loading) {
          loading = loadPagedReview(scope, reference, pageSignal, (params) => requestPage(params, pageSignal)).then(
            (content) => {
              pageSignal.throwIfAborted();
              verified = true;
              return content;
            },
          );
          void loading.catch(() => {});
        }
        return loading;
      },
      owned,
    );
    owned.throwIfAborted();
    if (approved === false) return false;
    if (approved !== true || !verified) throw new Error("Exact review details were not verified before approval.");
    return { approvedReview: reference.offer };
  } finally {
    lifetime.abort();
    await loading?.catch(() => {});
  }
}
