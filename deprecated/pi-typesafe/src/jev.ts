import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatJevResult, formatJevToolError, requestJevDecision, resolveJevProvider } from "./client.js";
import { DEFAULT_TYPESAFE_SETTINGS, loadSettings, settingsFilePath, type TypeSafeSettings } from "./settings.js";
import { normalizeJevInput } from "./validation.js";

export interface JevExtensionOptions {
  fetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  settingsPath?: string;
  settings?: Partial<TypeSafeSettings>;
  loadSettings?: typeof loadSettings;
}

const structuredValueDescription = "A string, JSON object, or JSON array.";
const structuredValueSchema = (description: string) =>
  Type.Union([Type.String(), Type.Record(Type.String(), Type.Any()), Type.Array(Type.Any())], { description });
const instructionsSchema = () => structuredValueSchema(`The complete narrow question. ${structuredValueDescription}`);
const questionSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Unsafe<"noul">(StringEnum(["noul"] as const, { description: "Return the probability of yes." })),
        instructions: instructionsSchema(),
        criteria: Type.Optional(
          Type.Object(
            {
              true: Type.String({ description: "What a yes means." }),
              false: Type.String({ description: "What a no means." }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Unsafe<"choice">(StringEnum(["choice"] as const, { description: "Select one named option." })),
        instructions: instructionsSchema(),
        criteria: Type.Record(
          Type.String({ minLength: 1 }),
          Type.Union([structuredValueSchema("The option description."), Type.Null()]),
          { minProperties: 2, maxProperties: 255 },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Unsafe<"score">(StringEnum(["score"] as const, { description: "Rate one ordered dimension." })),
        instructions: instructionsSchema(),
        criteria: Type.Array(structuredValueSchema("One concrete ordered level."), {
          minItems: 2,
          maxItems: 10,
        }),
      },
      { additionalProperties: false },
    ),
  ],
  { description: "One narrow noul, choice, or score question." },
);

export const jevToolParameters = Type.Object(
  {
    state: Type.Any({
      description: `Shared content to evaluate. ${structuredValueDescription}`,
    }),
    questions: Type.Record(Type.String({ minLength: 1 }), questionSchema, {
      minProperties: 1,
      description: "Named typed questions. Answers use the same names.",
    }),
  },
  { additionalProperties: false },
);

export function createJevTool(
  options: JevExtensionOptions = {},
  getSettings: () => TypeSafeSettings = () => applyRuntimeSettings(DEFAULT_TYPESAFE_SETTINGS, options.settings),
) {
  return defineTool({
    name: "typesafe_question",
    label: "TypeSafe: Question",
    description: `Ask TypeSafe Jev narrow typed questions about shared state through the official TypeSafe API, with an explicitly enabled OpenRouter fallback. Supports noul, choice, and score questions in one request. Returns validated JSON and never performs workflow actions. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Make fast typed noul, choice, or score decisions with TypeSafe Jev",
    promptGuidelines: [
      "Use typesafe_question for narrow routing, classification, scoring, or verification decisions when calibrated probabilities are useful; keep workflow actions in code or other tools.",
    ],
    parameters: jevToolParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const input = normalizeJevInput(params);
        const provider = await resolveJevProvider(ctx, options.env, getSettings().openRouterFallback);
        const response = await requestJevDecision(input, provider, signal, options.fetch);
        return formatJevResult(response);
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        throw formatJevToolError(error);
      }
    },
  });
}

export default function jevExtension(pi: ExtensionAPI, options: JevExtensionOptions = {}): void {
  let generation = 0;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let settings = applyRuntimeSettings(DEFAULT_TYPESAFE_SETTINGS, options.settings);
  const runtimeSettings = options.settings;
  const path = options.settingsPath ?? settingsFilePath();
  const readSettings = options.loadSettings ?? loadSettings;

  pi.registerTool(createJevTool(options, () => settings));
  pi.on("session_start", async (_event, ctx) => {
    const owner = ctx.sessionManager;
    activeSession = owner;
    const currentGeneration = ++generation;
    const loaded = await readSettings(path);
    if (currentGeneration !== generation || owner !== activeSession) return;
    settings = applyRuntimeSettings(loaded.settings, runtimeSettings);
    if (!loaded.warning) return;
    const warning = formatJevToolError(loaded.warning);
    if (ctx.mode === "print" || ctx.mode === "json") throw warning;
    if (ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc")) {
      ctx.ui.notify(warning.message, "warning");
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.sessionManager !== activeSession) return;
    activeSession = undefined;
    generation += 1;
  });
}

function applyRuntimeSettings(
  settings: Readonly<TypeSafeSettings>,
  override: Partial<TypeSafeSettings> | undefined,
): TypeSafeSettings {
  const openRouterFallback =
    override && Object.hasOwn(override, "openRouterFallback") && typeof override.openRouterFallback === "boolean"
      ? override.openRouterFallback
      : settings.openRouterFallback;
  return { openRouterFallback };
}

export type { JevProvider } from "./client.js";
export { formatJevResult, requestJevDecision, resolveJevProvider } from "./client.js";
export type {
  ChoiceAnswer,
  ChoiceQuestion,
  JevAnswer,
  JevDecisionInput,
  JevDecisionResponse,
  JevQuestion,
  JevUsage,
  JsonValue,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
  StructuredValue,
} from "./types.js";
export { normalizeJevInput, normalizeJevResponse } from "./validation.js";
