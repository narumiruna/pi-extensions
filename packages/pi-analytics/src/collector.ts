import { randomUUID } from "node:crypto";
import { classifyProviderError } from "./errors.js";
import type {
  GenerationOutcome,
  GenerationRecord,
  ModelIdentity,
  ProviderErrorRecord,
  RunOutcome,
  SettledRun,
  SkillActivationRecord,
  ToolCallRecord,
  TriggerSource,
} from "./types.js";

interface ActiveRun {
  id: string;
  startedAtMs: number;
  triggerSource: TriggerSource;
  initialModel?: ModelIdentity;
  attemptCount: number;
  generations: GenerationRecord[];
  generationIds: Set<string>;
  tools: ToolCallRecord[];
  toolIds: Set<string>;
  skills: SkillActivationRecord[];
  skillIndexes: Map<string, number>;
  providerErrors: ProviderErrorRecord[];
}

export class ResponseCollector {
  private active: ActiveRun | undefined;

  hasActiveRun(): boolean {
    return this.active !== undefined;
  }

  getActiveRunId(): string | undefined {
    return this.active?.id;
  }

  begin(input: {
    id: string;
    now: number;
    triggerSource: TriggerSource;
    model?: ModelIdentity;
  }): SettledRun | undefined {
    const interrupted = this.active ? this.finalize(input.now, "interrupted") : undefined;
    this.active = {
      id: input.id,
      startedAtMs: input.now,
      triggerSource: input.triggerSource,
      initialModel: input.model,
      attemptCount: 0,
      generations: [],
      generationIds: new Set(),
      tools: [],
      toolIds: new Set(),
      skills: [],
      skillIndexes: new Map(),
      providerErrors: [],
    };
    return interrupted;
  }

  beginAttempt(): void {
    if (this.active) this.active.attemptCount += 1;
  }

  beginGeneration(input: { id: string; now: number; model?: ModelIdentity }): void {
    const active = this.active;
    if (!active || active.generationIds.has(input.id)) return;
    active.generationIds.add(input.id);
    active.generations.push({
      id: input.id,
      ordinal: active.generations.length,
      provider: input.model?.provider,
      model: input.model?.model,
      thinkingLevel: input.model?.thinkingLevel,
      startedAtMs: input.now,
      outcome: "pending",
      responses: [],
    });
  }

  recordProviderResponse(input: { status: number; now: number }): void {
    const generation = this.latestGeneration();
    if (generation?.outcome !== "pending") return;
    generation.responses.push({
      ordinal: generation.responses.length,
      occurredAtMs: input.now,
      status: input.status,
    });
  }

  finishGeneration(input: { now: number; stopReason: string; errorMessage?: string }): void {
    const active = this.active;
    const generation = this.latestGeneration();
    if (!active || !generation || generation.outcome !== "pending") return;
    generation.finishedAtMs = input.now;
    generation.durationMs = elapsed(generation.startedAtMs, input.now);
    generation.stopReason = input.stopReason;
    generation.outcome = generationOutcome(input.stopReason);
    if (generation.outcome === "error") {
      active.providerErrors.push({
        id: randomUUID(),
        generationId: generation.id,
        occurredAtMs: input.now,
        provider: generation.provider,
        model: generation.model,
        category: classifyProviderError(input.errorMessage),
        recovered: false,
        terminal: true,
      });
    }
  }

  beginTool(input: { id: string; name: string; now: number; model?: ModelIdentity }): void {
    const active = this.active;
    if (!active || active.toolIds.has(input.id)) return;
    active.toolIds.add(input.id);
    active.tools.push({
      id: input.id,
      ordinal: active.tools.length,
      name: input.name,
      provider: input.model?.provider,
      model: input.model?.model,
      startedAtMs: input.now,
      isError: false,
      completionState: "running",
    });
  }

  finishTool(input: { id: string; now: number; isError: boolean }): void {
    const tool = this.active?.tools.find(({ id }) => id === input.id);
    if (tool?.completionState !== "running") return;
    tool.finishedAtMs = input.now;
    tool.durationMs = elapsed(tool.startedAtMs, input.now);
    tool.isError = input.isError;
    tool.completionState = "finished";
  }

  activateSkill(input: { name: string; initiatedBy: "user" | "model"; now: number; model?: ModelIdentity }): void {
    const active = this.active;
    if (!active) return;
    const existingIndex = active.skillIndexes.get(input.name);
    if (existingIndex !== undefined) {
      const existing = active.skills[existingIndex];
      if (existing && existing.initiatedBy === "model" && input.initiatedBy === "user") {
        existing.initiatedBy = "user";
        existing.occurredAtMs = input.now;
        existing.provider = input.model?.provider;
        existing.model = input.model?.model;
      }
      return;
    }
    active.skillIndexes.set(input.name, active.skills.length);
    active.skills.push({
      id: randomUUID(),
      name: input.name,
      initiatedBy: input.initiatedBy,
      occurredAtMs: input.now,
      provider: input.model?.provider,
      model: input.model?.model,
    });
  }

  settle(now: number): SettledRun | undefined {
    return this.finalize(now);
  }

  interrupt(now: number): SettledRun | undefined {
    return this.finalize(now, "interrupted");
  }

  private latestGeneration(): GenerationRecord | undefined {
    return this.active?.generations.at(-1);
  }

  private finalize(now: number, forcedOutcome?: RunOutcome): SettledRun | undefined {
    const active = this.active;
    if (!active) return undefined;
    this.active = undefined;

    for (const generation of active.generations) {
      if (generation.outcome !== "pending") continue;
      generation.outcome = "interrupted";
      generation.finishedAtMs = now;
      generation.durationMs = elapsed(generation.startedAtMs, now);
    }
    for (const tool of active.tools) {
      if (tool.completionState !== "running") continue;
      tool.completionState = "interrupted";
      tool.finishedAtMs = now;
      tool.durationMs = elapsed(tool.startedAtMs, now);
    }

    const successfulGenerationIndexes = new Set(
      active.generations
        .map((generation, index) => ({ generation, index }))
        .filter(({ generation }) => isSuccessfulGeneration(generation))
        .map(({ index }) => index),
    );
    let recoveredHttpErrors = 0;
    let httpErrors = 0;
    for (const [generationIndex, generation] of active.generations.entries()) {
      const hasLaterSuccess = [...successfulGenerationIndexes].some((index) => index > generationIndex);
      for (const [responseIndex, response] of generation.responses.entries()) {
        if (response.status < 400) continue;
        httpErrors += 1;
        const laterSuccessInGeneration = generation.responses
          .slice(responseIndex + 1)
          .some(({ status }) => status >= 200 && status < 400);
        if (laterSuccessInGeneration || hasLaterSuccess) recoveredHttpErrors += 1;
      }
    }
    for (const error of active.providerErrors) {
      const generationIndex = active.generations.findIndex(({ id }) => id === error.generationId);
      error.recovered = [...successfulGenerationIndexes].some((index) => index > generationIndex);
      error.terminal = !error.recovered;
    }

    const recoveredGenerationErrors = active.providerErrors.filter(({ recovered }) => recovered).length;
    const providerErrorCount = httpErrors + active.providerErrors.length;
    const recoveredErrorCount = recoveredHttpErrors + recoveredGenerationErrors;
    const outcome = forcedOutcome ?? deriveOutcome(active.generations, providerErrorCount);

    return {
      id: active.id,
      startedAtMs: active.startedAtMs,
      finishedAtMs: now,
      durationMs: elapsed(active.startedAtMs, now),
      triggerSource: active.triggerSource,
      initialProvider: active.initialModel?.provider,
      initialModel: active.initialModel?.model,
      outcome,
      attemptCount: active.attemptCount,
      generations: active.generations,
      tools: active.tools,
      skills: active.skills,
      providerErrors: active.providerErrors,
      toolErrorCount: active.tools.filter(({ isError }) => isError).length,
      providerErrorCount,
      recoveredErrorCount,
    };
  }
}

function elapsed(start: number, end: number): number {
  return Math.max(0, end - start);
}

function generationOutcome(stopReason: string): GenerationOutcome {
  switch (stopReason) {
    case "stop":
      return "stop";
    case "toolUse":
      return "tool_use";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    case "length":
      return "length";
    default:
      return "interrupted";
  }
}

function isSuccessfulGeneration(generation: GenerationRecord): boolean {
  return generation.outcome === "stop" || generation.outcome === "tool_use";
}

function deriveOutcome(generations: readonly GenerationRecord[], providerErrors: number): RunOutcome {
  const last = generations.at(-1);
  if (!last) return providerErrors > 0 ? "error" : "success";
  switch (last.outcome) {
    case "stop":
    case "tool_use":
      return providerErrors > 0 ? "recovered_success" : "success";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    case "length":
      return "length";
    default:
      return "interrupted";
  }
}
