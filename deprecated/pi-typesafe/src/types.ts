export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type StructuredValue = string | JsonValue[] | { [key: string]: JsonValue };

export interface NoulQuestion {
  type: "noul";
  instructions: StructuredValue;
  criteria?: {
    true: string;
    false: string;
  };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: StructuredValue;
  criteria: Record<string, StructuredValue | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: StructuredValue;
  criteria: StructuredValue[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface JevDecisionInput {
  state: StructuredValue;
  questions: Record<string, JevQuestion>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, StructuredValue>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
}

export interface JevDecisionResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
}
