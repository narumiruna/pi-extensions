# Question design

Read this reference to choose a primitive, write its instructions and criteria, and interpret its answer.

## Choose the answer shape

| Need | Primitive | Answer |
| --- | --- | --- |
| Select one item from a known unordered set | Choice | `choice`, `probabilities`, `confidence` |
| Estimate whether one condition holds | Noul | `noul` from 0 to 1 |
| Place an item on an ordered descriptive scale | Score | `score`, `legend`, `probabilities`, `confidence` |

Choose the primitive whose output your code can use directly.
Add an `other` or `none` Choice option when the supplied set may not cover the input.
Use separate Noul questions when several labels may all apply.
Use Score for intensity or degree rather than treating a Noul value as an intensity scale.

## Shared rules

Each question has an ID, `type`, `instructions`, and type-specific `criteria`.
The ID keys the returned answer but is not sent to the model.
Write the complete judgment in `instructions`.

Ask one narrow, coherent judgment per question.
Split dimensions when each answer remains independently meaningful.
Do not split away a relationship that the model must judge as a whole.

Strings are sufficient for simple instructions and criteria.
Use objects or arrays when named fields clarify definitions, contrasts, exclusions, evidence, or examples.
Use the same field names across comparable criteria.

```json
{
  "instructions": {
    "question": "Which return topic is the customer asking about?",
    "focus": "Classify the information the customer wants."
  },
  "criteria": {
    "return_policy": {
      "what": "Whether and how an item can be returned",
      "not_for": "Progress of a return already sent"
    },
    "return_status": {
      "what": "Progress of a return already sent",
      "not_for": "Whether an item is eligible for return"
    }
  }
}
```

Reference structured state with backticked paths such as `ticket.messages[0].text`.
Include source text, identities, relationships, policies, and candidate values needed to answer.
A model cannot select a candidate that code omitted.

## Choice

Use Choice when exactly one supplied option should win.
`criteria` is a map from option names to descriptions.
A description may be `null` when the option name is unambiguous.
The source snapshot documents a maximum of 255 options.
Check the live API before depending on that limit.

```json
{
  "type": "choice",
  "instructions": "Which team should handle `ticket.message`?",
  "criteria": {
    "billing": "Charges, invoices, and refunds",
    "technical": "Bugs, outages, and integrations",
    "sales": "Pricing, upgrades, and new accounts",
    "other": "None of the supplied teams fits"
  }
}
```

A Choice answer contains:

- `choice`: the highest-probability option.
- `probabilities`: every option mapped to a probability that sums to 1.
- `confidence`: a summary of how concentrated the distribution is.

Low confidence may mean the input spans multiple options, none fits clearly, or evidence is missing.
A meaningful second-place probability can be useful even when the top option drives routing.

## Noul

Use Noul for one yes-or-no judgment where the probability of yes is useful.
Phrase the question so a higher value has an unambiguous meaning.
Optional `criteria.true` and `criteria.false` descriptions can define a subtle boundary.

```json
{
  "type": "noul",
  "instructions": "Does `ticket.message` explicitly request a refund?",
  "criteria": {
    "true": "Directly asks for money back or account credit",
    "false": "Reports a billing issue without requesting that remedy"
  }
}
```

A Noul answer contains `noul`, the probability that the answer is yes.
Values near 1 indicate strong yes, values near 0 strong no, and values near 0.5 uncertainty between yes and no.
Noul has no separate `confidence` field.

Use one Noul per independently possible label.
For example, a message can simultaneously request a refund, express urgency, and contain personal data.

## Score

Use Score for one ordered dimension with concrete descriptive levels.
`criteria` is an ordered array with at least two levels.
The source snapshot documents at most 10 levels.
Each level number is its zero-based array position.

```json
{
  "type": "score",
  "instructions": "How severe is the issue in `ticket.message`?",
  "criteria": [
    "Cosmetic; no impact to functionality",
    "Broken or degraded feature, but a workaround exists",
    "Blocking issue with no workaround"
  ]
}
```

A Score answer contains:

- `score`: the probability-weighted position across level numbers.
- `legend`: level numbers mapped back to descriptions.
- `probabilities`: level numbers mapped to probabilities.
- `confidence`: a summary of distribution concentration.

Different distributions can produce the same `score`.
Read `probabilities` and `confidence` when ambiguity matters.
Normalize scores before combining scales with different numbers of levels:

```python
normalized = answer.score / (len(criteria) - 1)
```

Write levels as standalone situations, not vague degrees such as “low,” “medium,” and “high.”
The model evaluates each description on its own and does not see neighboring level numbers.
Do not write “worse than the previous level.”
Keep one dimension per Score question.
Add a distinct extreme level when code must treat that case differently.

## Batch questions

Questions in one request share the same state, run independently, and cannot see one another's answers.
Batch independent and branch-specific questions when they use the same state.
Code can ignore answers from branches it does not take.
Extra questions still consume tokens, so measure the real request budget.

Make a second request only when an earlier answer is needed to obtain evidence, construct new state, or choose the next options.
Hierarchical traversal and multi-pass structure recovery are valid examples.
See [Composition patterns](composition-patterns.md) and the [cookbooks](index.md#local-references).

## Validate question behavior

Test representative positives, negatives, ambiguous inputs, missing evidence, and no-match cases.
Inspect exact state, question text, criteria, distributions, code composition, and final application action when a case fails.
Distinguish model errors from missing evidence, bad candidate coverage, incorrect code, and service failures.
Higher confidence alone does not prove a revised question is more accurate.
