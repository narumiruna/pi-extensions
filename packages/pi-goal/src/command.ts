const MAX_OBJECTIVE_LENGTH = 4_000;

const REMOVED_QUEUE_COMMANDS = new Set(["add", "prioritize", "drop-last", "skip", "push", "unshift", "pop", "shift"]);

export interface CommandResult {
  kind: "start" | "pause" | "resume" | "clear" | "show" | "edit";
  objective?: string;
  tokenBudget?: number;
}

export interface GoalArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

const TOKEN_BUDGET_COMPLETION: GoalArgumentCompletion = {
  value: "--tokens ",
  label: "--tokens",
  description: "Set a token budget before the goal",
};
const GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
  { value: "pause", label: "pause", description: "Pause the active goal" },
  { value: "resume", label: "resume", description: "Resume a stopped or budget-limited goal" },
  { value: "clear", label: "clear", description: "Clear the current goal" },
  { value: "edit", label: "edit", description: "Edit the current goal objective" },
  { value: "status", label: "status", description: "Show the current goal" },
  TOKEN_BUDGET_COMPLETION,
];

export function completeGoalArguments(argumentPrefix: string): GoalArgumentCompletion[] | null {
  const prefix = argumentPrefix.trimStart();
  if (prefix === "") return [...GOAL_ARGUMENT_COMPLETIONS];

  const objectiveOption = /^edit\s+(\S*)$/.exec(prefix);
  if (objectiveOption) {
    const optionPrefix = objectiveOption[1] ?? "";
    return optionPrefix === "" || "--tokens".startsWith(optionPrefix)
      ? [
          {
            value: "edit --tokens ",
            label: "--tokens",
            description: "Set a token budget before the updated goal",
          },
        ]
      : null;
  }
  if (/\s/.test(prefix)) return null;
  const matches = GOAL_ARGUMENT_COMPLETIONS.filter(
    (item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
  );
  return matches.length > 0 ? matches : null;
}

export function parseCommand(args: string): CommandResult | string {
  const input = args.trim();
  if (input === "") return { kind: "show" };
  const [first, rest] = splitHead(input);
  if (first === "pause") return rest === "" ? { kind: "pause" } : "Usage: /goal pause";
  if (first === "resume") return rest === "" ? { kind: "resume" } : "Usage: /goal resume";
  if (first === "clear" || first === "stop") return rest === "" ? { kind: "clear" } : "Usage: /goal clear";
  if (first === "status") return rest === "" ? { kind: "show" } : "Usage: /goal status";
  if (first === "edit") return parseObjective("edit", rest);

  return parseObjective("start", input);
}

export function isRemovedQueueCommand(args: string) {
  const [first] = tokenize(args.trim());
  return first !== undefined && REMOVED_QUEUE_COMMANDS.has(first);
}

function parseObjective(kind: "start" | "edit", input: string): CommandResult | string {
  const [option, rest] = splitHead(input);
  let objective = input;
  let tokenBudget: number | undefined;
  if (option === "--tokens") {
    const [rawBudget, body] = splitHead(rest);
    if (!rawBudget) {
      return kind === "start"
        ? "Usage: /goal --tokens 100k <goal_to_complete>"
        : `Usage: /goal ${kind} --tokens 100k <goal_to_complete>`;
    }
    tokenBudget = parseTokenBudget(rawBudget);
    if (tokenBudget === undefined) return `Invalid token budget: ${rawBudget}`;
    objective = body;
  }
  if (objective === "") {
    if (kind === "start") return "Usage: /goal <goal_to_complete>";
    return `Usage: /goal ${kind} <goal_to_complete>`;
  }
  return { kind, objective, tokenBudget };
}

function splitHead(input: string): [string, string] {
  const boundary = input.search(/\s/);
  return boundary === -1 ? [input, ""] : [input.slice(0, boundary), input.slice(boundary).trimStart()];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseTokenBudget(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
  return normalizeTokenBudget(Math.floor(amount * multiplier));
}

export function validateObjective(objective: string): string | undefined {
  const trimmed = objective.trim();
  if (!trimmed) return "Usage: /goal <goal_to_complete>";
  if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
    return `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
  }
  return undefined;
}

function normalizeTokenBudget(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
