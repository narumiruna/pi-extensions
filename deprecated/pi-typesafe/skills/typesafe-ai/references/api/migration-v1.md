# Migrate to the v1 API

Use this reference only for integrations built against the preview evaluation endpoint or the old Python client.
New integrations should use the [current HTTP API](http.md) or an SDK directly.

## Breaking changes

| Area | Preview | v1 |
| --- | --- | --- |
| Endpoint | `POST /preview/evaluation` | `POST /v1/systemone` |
| Input | `document` | `state` |
| Questions | `prompts` array with a `key` per item | `questions` map keyed by ID |
| Choice criteria | `options` array | `criteria` map |
| Score criteria | `levels` objects | Positional `criteria` array |
| Answers | Ordered `responses` array | `answers` map keyed by question ID |
| Noul value | `probability` | `noul` |
| Choice value | `chosen` | `choice` |
| Score value | `expectation` | `score` |
| Choice probabilities | Array of objects | Option-to-probability map |
| Score probabilities | Not returned | Level-to-probability map |
| Usage | `billing_units` | `input_tokens` and `output_tokens` |
| Python package | `typesafe-client` | `typesafe-sdk` |

Authentication remains a bearer token with JSON content type.

## Request conversion

Preview:

```json
{
  "model": "jev-latest",
  "document": "Sample document",
  "prompts": [
    {
      "key": "is_relevant",
      "type": "noul",
      "instructions": "Is this relevant?"
    }
  ]
}
```

v1:

```json
{
  "model": "jev-latest",
  "state": "Sample document",
  "questions": {
    "is_relevant": {
      "type": "noul",
      "instructions": "Is this relevant?"
    }
  }
}
```

Choice criteria now map option names directly to descriptions:

```json
{
  "type": "choice",
  "instructions": "Which team should handle this?",
  "criteria": {
    "billing": "Payments and refunds",
    "technical": "Bugs and integrations"
  }
}
```

Score criteria now use contiguous zero-based array positions:

```json
{
  "type": "score",
  "instructions": "How severe is the issue?",
  "criteria": ["Cosmetic", "Degraded", "Blocking"]
}
```

## Response conversion

Preview returned an ordered `responses` array and per-type legacy field names.
v1 returns an `answers` map under the IDs supplied in `questions`.

```json
{
  "answers": {
    "is_relevant": {
      "type": "noul",
      "noul": 0.92
    }
  },
  "usage": {
    "input_tokens": 312,
    "output_tokens": 48
  }
}
```

Choice probabilities are now an option-to-probability map.
Score answers now include `legend` and a level-to-probability map.

## Confidence migration

The v1 confidence computation differs from preview.
Re-evaluate every confidence-based threshold on representative data instead of carrying it over unchanged.
Both Choice and Score expose the full distribution, so application code can compute another uncertainty statistic when needed.

## Python migration

| Old client | Current client |
| --- | --- |
| `from typesafe_client import TypeSafeClient` | `from typesafe_sdk import TypeSafeClient` |
| `evaluate(...)` or `evaluate_async(...)` | `system_one(...)` or async `system_one(...)` |
| `*Prompt` or `*Question` classes | `Noul`, `Choice`, and `Score` |
| `system_one(model, document, questions)` | `system_one(state, questions)` with an optional model |
| `response[key]` and helper methods | `response.answers[key]` or typed collections |
| `.probability`, `.chosen`, `.expectation` | `.noul`, `.choice`, `.score` |

The old `typesafe-client` package sends the obsolete request shape and does not work against v1.
See the [Python SDK reference](../sdk/python.md) for current examples.
