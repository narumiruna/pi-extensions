import {
  type NoulQuestion,
  type NoulResponse,
  noul,
  type Questions,
  type RequestOptions,
  type SystemOneRequest,
  type SystemOneResult,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { HistoryUnit } from "./history-units.js";

export const JEV_EVALUATOR_MODEL = "jev-latest";
export const NOUL_SUMMARIZE_THRESHOLD = 0.5;
export const MAX_EVALUATOR_BATCH_UNITS = 24;
export const MAX_EVALUATOR_BATCH_BYTES = 96 * 1024;

export interface EvaluationDecision {
  unit: HistoryUnit;
  summarize: boolean;
  probability: number;
}

export interface EvaluationResult {
  decisions: EvaluationDecision[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface TypeSafeSystemOneClient {
  systemOne<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): PromiseLike<SystemOneResult<Q>>;
}

export type TypeSafeClientFactory = (apiKey: string) => TypeSafeSystemOneClient;

export const createTypeSafeClient: TypeSafeClientFactory = (apiKey) => new TypeSafeClient({ apiKey, logLevel: "off" });

function batchBytes(units: readonly HistoryUnit[]): number {
  return Buffer.byteLength(JSON.stringify(evaluationRequest(units)), "utf8");
}

export function batchHistoryUnits(units: readonly HistoryUnit[]): HistoryUnit[][] {
  const batches: HistoryUnit[][] = [];
  let current: HistoryUnit[] = [];
  for (const unit of units) {
    const candidate = [...current, unit];
    const candidateBytes = batchBytes(candidate);
    let currentBytes = candidateBytes;
    if (
      current.length > 0 &&
      (candidate.length > MAX_EVALUATOR_BATCH_UNITS || candidateBytes > MAX_EVALUATOR_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [unit];
      currentBytes = batchBytes(current);
    } else {
      current = candidate;
    }
    if (currentBytes > MAX_EVALUATOR_BATCH_BYTES) {
      throw new Error(`History unit ${unit.id} exceeds the TypeSafe batch limit`);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function evaluationQuestions(units: readonly HistoryUnit[]): Record<string, NoulQuestion> {
  return Object.fromEntries(
    units.map((unit, index) => [
      `decision_${String(index).padStart(3, "0")}`,
      noul(
        {
          task: "Should this history unit be incorporated into the compacted summary?",
          unitId: unit.id,
          evaluationGuidance:
            "Answer yes for durable goals, constraints, decisions, progress, errors, file changes, or context needed to continue. Answer no when the unit should remain as labelled retained history instead of being summarized.",
        },
        {
          true: "Summarize this unit with the user's active Pi model.",
          false: "Keep this unit in the retained-history representation.",
        },
      ),
    ]),
  );
}

function evaluationRequest(units: readonly HistoryUnit[]) {
  return {
    model: JEV_EVALUATOR_MODEL,
    state: {
      task: "Classify each history unit independently for selective Pi compaction.",
      units: units.map(({ id, order, kind, source, label, content }) => ({
        id,
        order,
        kind,
        source,
        label,
        content,
      })),
    },
    questions: evaluationQuestions(units),
  };
}

function isNoulResponse(value: unknown): value is NoulResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { type?: unknown; noul?: unknown };
  return (
    response.type === "noul" &&
    typeof response.noul === "number" &&
    Number.isFinite(response.noul) &&
    response.noul >= 0 &&
    response.noul <= 1
  );
}

export async function evaluateHistoryUnits(
  client: TypeSafeSystemOneClient,
  units: readonly HistoryUnit[],
  signal: AbortSignal,
): Promise<EvaluationResult> {
  const decisions: EvaluationDecision[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const batch of batchHistoryUnits(units)) {
    signal.throwIfAborted();
    const request = evaluationRequest(batch);
    const result = await client.systemOne(request, { signal });
    signal.throwIfAborted();
    // The SDK uses null for unreported usage; totals include only reported tokens.
    const batchInputTokens = result.usage.input_tokens ?? 0;
    const batchOutputTokens = result.usage.output_tokens ?? 0;
    if (
      !Number.isSafeInteger(batchInputTokens) ||
      batchInputTokens < 0 ||
      !Number.isSafeInteger(batchOutputTokens) ||
      batchOutputTokens < 0
    ) {
      throw new Error("TypeSafe returned invalid usage counts");
    }
    inputTokens += batchInputTokens;
    outputTokens += batchOutputTokens;
    for (const [index, unit] of batch.entries()) {
      const name = `decision_${String(index).padStart(3, "0")}`;
      const answer = result.answers[name];
      if (!isNoulResponse(answer)) {
        throw new Error(`TypeSafe returned an invalid or missing Noul answer for ${unit.id}`);
      }
      decisions.push({
        unit,
        probability: answer.noul,
        summarize: answer.noul >= NOUL_SUMMARIZE_THRESHOLD,
      });
    }
  }
  return { decisions, usage: { inputTokens, outputTokens } };
}
