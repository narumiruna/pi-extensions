# TypeSafe concepts

Read this reference to decide whether TypeSafe fits a workflow and what belongs in model state, questions, and ordinary code.

## System One

A System One model evaluates natural-language state and returns typed judgments and probabilities.
Jev is TypeSafe's flagship System One model.
It does not generate prose, code, or reasoning explanations.
It selects among answer shapes defined by [Choice, Noul, and Score questions](question-design.md).

System One probabilities are trained for calibrated decisions across groups of predictions.
Calibration does not guarantee that an individual answer is correct.
Validate judgments and thresholds on representative data from the target domain.

Jev accepts text represented as a string, JSON object, or array.
The source snapshot says images, audio, and video are not supported.
English is the primary training language, and other languages may have lower accuracy.
Check the live model documentation before relying on current modality or language support.

## AI-powered software

Build a normal software workflow and insert System One only where semantic judgment helps.

Keep these responsibilities in code:

- Deterministic rules and calculations.
- Exact lookups and database access.
- Control flow, permissions, and side effects.
- Candidate generation and exact value copying.
- Thresholds, weights, retries, logging, and escalation policy.

Use System One for bounded questions such as:

- Which known category best fits this input?
- Does a specific condition hold?
- Where does an item fall on a described scale?
- Which candidate is relevant to the user's stated intent?
- Does supplied evidence support a claim or extracted field?

Typed output constrains the interface, not the truth of the answer.
Do not use model confidence as authorization for a destructive action.

## State

State is the shared content evaluated by every question in one request.
A string works for one simple text.
Use an object for most workflows so names and relationships remain explicit.
Use an array for ordered messages or records.

```json
{
  "ticket": {
    "message": "I was charged twice for order A-104. Please refund the duplicate."
  },
  "order": {
    "id": "A-104",
    "charges": [
      {"amount_usd": 49, "status": "captured"},
      {"amount_usd": 49, "status": "captured"}
    ]
  },
  "refund_policy": "Duplicate charges are eligible for a refund."
}
```

Include current facts, policies, candidates, and relationships needed for the judgment.
Do not rely on model memory when your application can supply authoritative data.
Remove unrelated context that could distract from the question.
Keep inferred state separate from observed facts.

Reference nested values explicitly in question instructions with backticked paths such as `ticket.message` or `order.charges[0]`.
The question ID is only a response key and is not sent to the model.
Put the full meaning in `instructions`.

## Design a workflow

1. Define the application behavior or decision that code must produce.
2. Implement known rules and exact operations in code first.
3. Identify only the semantic judgments that remain.
4. Supply the smallest state that preserves the evidence and relationships each judgment needs.
5. Split broad judgments into narrow questions whose answers are independently useful.
6. Ask independent questions over the same state in one request.
7. Combine answers with explicit code, weights, and action-specific thresholds.
8. Route uncertain or high-risk cases to clarification, human review, or a reasoning model.
9. Test the complete application behavior on representative and adversarial cases.

A second model request is justified when the first answer is needed to fetch evidence, build new state, or determine the next candidate set.
Otherwise, batch the questions and ignore branch-specific answers that are not used.
See [Composition patterns](composition-patterns.md).

## Where it fits

Common decision shapes include:

| Shape | Examples |
| --- | --- |
| Classification | Intent, topic, department, risk type, entity type |
| Detection | Spam, fraud, urgency, sensitive data, prompt injection |
| Scoring | Severity, relevance, quality, frustration, suitability |
| Routing | Handler selection, escalation, model routing, support queues |
| Search and ranking | Query-candidate relevance, RAG context, recommendations |
| Verification | Citation support, policy compliance, extraction checks, tool-call checks |
| Feature extraction | Semantic signals for a downstream classical model |
| Structured extraction | Candidate selection, attributes, document labels |

Useful domains include customer support, recruiting, compliance, moderation, marketplaces, advertising, risk, research, and AI harnesses.
Start from the user's desired behavior rather than forcing the problem into a generic classifier.

## Confidence and action policy

Choice and Score return a probability distribution plus `confidence` from 0 to 1.
A concentrated distribution has higher confidence, while a spread distribution has lower confidence.
Noul returns only the probability of yes and has no separate confidence field.
A Noul near 0.5 means yes and no have similar probability; it does not mean medium intensity.

Use uncertainty with an explicit action policy:

- Act automatically only when the action is low risk and validation supports the threshold.
- Ask for confirmation or gather more evidence in an intermediate range.
- Escalate low-confidence or high-consequence cases.
- Inspect the full distribution when alternatives matter.
- Ignore uncertainty on speculative branches that code does not use.

Do not copy threshold values from examples as universal defaults.
Choose thresholds from measured target-domain behavior and the cost of each error.
Different actions in the same workflow may require different thresholds.
