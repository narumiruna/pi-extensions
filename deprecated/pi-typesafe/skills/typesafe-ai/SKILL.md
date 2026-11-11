---
name: typesafe-ai
license: MIT
description: >-
  Build AI-powered software with TypeSafe and Jev, or use pi-typesafe's typesafe_question tool for typed semantic judgments and probabilities.
  Use when a feature needs programmable common sense, when an LLM prompt-and-parse step could become a structured decision, or when designing, calling, evaluating, or troubleshooting TypeSafe workflows for routing, ranking, extraction, verification, scoring, and interactive experiences.
  Read the bundled references and relevant cookbook before composing production questions or integrations.
---

# Build with TypeSafe

TypeSafe makes units of AI intelligence usable like programming primitives: small judgments that code can compose into larger capabilities.
Its System One models return focused typed judgments and probabilities instead of prose or reasoning explanations.
Jev is TypeSafe's flagship System One model.
Keep workflow, policy, exact calculations, permissions, and side effects in code.

## Read the bundled references

The bundled TypeSafe references are local snapshots for task use.
The live TypeSafe documentation remains authoritative when freshness matters.

- Start with the [reference index](references/index.md), then load only the files relevant to the task.
- Read [System One and workflow concepts](references/concepts.md) before deciding whether TypeSafe fits a new workflow.
- Read [question design](references/question-design.md) before composing Choice, Noul, or Score questions.
- Read [composition patterns](references/composition-patterns.md) when batching, combining signals, or gating actions.
- For an integration, read the matching [HTTP API](references/api/http.md), [Python SDK](references/sdk/python.md), or [JavaScript SDK](references/sdk/javascript.md) reference.
- For an older integration, read the [v1 migration guide](references/api/migration-v1.md) before changing request or response shapes.
- For a new workflow, inspect the closest cookbook: [routing and extraction](references/cookbooks/routing-and-extraction.md), [retrieval and classification](references/cookbooks/retrieval-and-classification.md), or [verification and learning](references/cookbooks/verification-and-learning.md).
- If a snapshot appears stale or omits a needed detail, consult the upstream source recorded in the index or the installed SDK types.
- State any access limitation and do not invent version-dependent fields, limits, retries, or model behavior.

## Use `typesafe_question`

When the `typesafe_question` tool is active, prefer it for direct Jev judgments instead of constructing an HTTP request manually.
Read its active schema before the first call because the tool validates each primitive's request shape.
Supply one shared `state` and a non-empty map of named `questions`.
Do not add provider credentials, endpoints, or model fields to tool input.
The extension prefers the official TypeSafe API when `TYPESAFE_API_KEY` is available and uses its experimental OpenRouter fallback only when `openRouterFallback: true` in the package-owned `pi-typesafe.json` settings file explicitly enables it.
A provider failure is not a reason to change a valid question or silently switch workflows.

## Find the useful shape

Start from the behavior the user wants the application to show, select, change, or hand off.
Work backward to the semantic judgments that behavior needs.
Implement known rules, calculations, exact lookups, candidate generation, and execution in code first.
Preserve the user's chosen stack and scope.

Consider more than generic classification:

- **Route and fill known arguments.** Select a handler and closed-set arguments, then validate and execute them in code.
- **Select instead of generate.** Find candidate values or source spans in code, use a judgment to select one, then copy and normalize it deterministically.
- **Find and judge evidence.** Retrieve candidates, evaluate query-candidate relevance, and pass only useful evidence onward.
- **Turn judgments into reusable data.** Preserve probabilities and normalized scores so code can change weights, thresholds, rankings, and views without rerunning inference.
- **Verify and escalate.** Check specific claims or fields against supplied evidence and route uncertain or failing cases to a person or reasoning model.
- **Respond to changing state.** Keep observed facts separate from inferred state and verify freshness before applying a result.

For an open-ended request, recommend the few directions that best serve the user's goal.
For a concrete request, choose the relevant pattern and proceed without forcing a brainstorming detour.

## Choose the primitive

Choose by what the answer means:

| Need | Primitive | Important distinction |
| --- | --- | --- |
| One item from a defined set | [Choice](references/question-design.md#choice) | Picks one option and compares competing options in one distribution |
| Whether one condition holds | [Noul](references/question-design.md#noul) | Returns yes probability with no separate confidence field |
| Degree along one ordered dimension | [Score](references/question-design.md#score) | Returns a probability-weighted position over concrete ordered levels |

Use one Noul per independently applicable label instead of forcing several labels into one Choice.
Include a no-match Choice option when the supplied options may not cover the input.
Use Score for intensity or degree instead of interpreting a Noul value as an intensity scale.

## Design the judgment

Give every question enough relevant state to answer, including source text, identities, relationships, policies, and current facts.
Prefer named JSON fields when context has several parts.
Reference nested state with backticked paths such as `ticket.messages[0].text`.
Put the complete judgment in `instructions` because question IDs are response keys and are not sent to the model.
Define possible answers in `criteria` using the exact shape required by the selected primitive.

Ask one narrow, coherent judgment per question.
Split dimensions when each answer remains independently useful, but do not split away a relationship the model must judge as a whole.
Use structured objects or arrays when named definitions, contrasts, exclusions, or examples clarify the judgment.
Write every Score level as a concrete standalone situation.
Check candidate coverage before asking for a selection because the model cannot choose an omitted value.

## Compose the workflow

Ask independent questions over the same state together, including useful branch-specific questions.
State each speculative premise inside its question because questions cannot see one another's answers.
Use a second request only when an earlier answer is needed to fetch evidence, construct new state, or determine later options.
Measure the actual request budget, cost, and end-to-end latency because extra questions still consume tokens.

Keep thresholds, weights, permissions, retries, and actions explicit in code.
Normalize Scores before combining scales with different numbers of levels.
Use weighted sums only when dimensions may compensate for one another.
Use separate conditions and explicit-any gates when one serious failure must trigger escalation.
Preserve raw answers and distributions when policy may change without new evidence.

## Handle uncertainty and failures

Treat Choice and Score confidence as distribution concentration, not proof that the result is correct or permission to act.
Treat a Noul near 0.5 as similar probability for yes and no, not medium intensity.
Inspect the full distribution when alternatives matter.
Ignore uncertainty only on speculative branches that code does not consume.
Choose thresholds from representative target-domain data and the consequence of each error.

When local validation fails, identify the exact rejected field and reread that primitive's contract.
Change only the invalid field instead of rewriting valid sibling questions or substituting another primitive to bypass validation.
Separate local schema failures, missing evidence, model judgment errors, provider failures, rate limits, and billing errors before deciding whether to retry.
Stop after a clear non-transient provider failure unless the user asks to retry.

Test representative positive, negative, ambiguous, missing-evidence, and no-match cases.
Inspect the exact state, questions, candidates, answers, distributions, composition, and resulting application behavior when a case fails.
Treat cookbook thresholds and reported results as examples to evaluate, not universal defaults or permanent model limitations.
Keep API credentials server-side and never include secrets in state, instructions, criteria, logs, or examples.
