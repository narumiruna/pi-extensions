# HTTP API

Use the HTTP API when an SDK is unavailable or the application needs direct request control.
Check the live API reference before depending on limits, retry headers, model aliases, or newly added fields.

## Endpoint

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

Keep API keys server-side.
Do not expose them in browser code or committed configuration.

## Request

The body contains one state, a model, and a map of named questions.

```json
{
  "state": "Help! My payouts have failed for three days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this message convey urgency?"
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoices, and refunds",
        "technical": "Bugs, outages, and integrations",
        "sales": "Pricing, upgrades, and new accounts"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `state` | string, object, or array | Yes | Textual content and context shared by all questions |
| `model` | string | Yes | Model alias or identifier; the source examples use `jev-latest` |
| `questions` | map of ID to question | Yes | Typed questions whose answers return under the same IDs |

Question fields:

| Type | Required fields | Criteria shape |
| --- | --- | --- |
| Noul | `type`, `instructions` | Optional object with `true` and `false` descriptions |
| Choice | `type`, `instructions`, `criteria` | Map from option to a description or `null` |
| Score | `type`, `instructions`, `criteria` | Ordered array of at least two level descriptions |

Instructions and criteria descriptions may be strings, objects, or arrays.
See [Question design](../question-design.md) before creating production questions.

## Response

```json
{
  "model": "jev-latest",
  "answers": {
    "is_urgent": {
      "type": "noul",
      "noul": 0.92
    },
    "department": {
      "type": "choice",
      "choice": "technical",
      "probabilities": {
        "billing": 0.08,
        "technical": 0.85,
        "sales": 0.07
      },
      "confidence": 0.82
    },
    "frustration": {
      "type": "score",
      "score": 1.6,
      "legend": {
        "0": "Calm",
        "1": "Frustrated",
        "2": "Very angry"
      },
      "probabilities": {
        "0": 0.05,
        "1": 0.3,
        "2": 0.65
      },
      "confidence": 0.78
    }
  },
  "usage": {
    "input_tokens": 312,
    "output_tokens": 48
  }
}
```

Top-level fields:

| Field | Meaning |
| --- | --- |
| `model` | Model that performed the evaluation |
| `answers` | Map keyed by the request's question IDs |
| `usage.input_tokens` | Input token count |
| `usage.output_tokens` | Output token count |

Answer fields:

| Type | Fields |
| --- | --- |
| Noul | `type`, `noul` |
| Choice | `type`, `choice`, `probabilities`, `confidence` |
| Score | `type`, `score`, `legend`, `probabilities`, `confidence` |

Choice probabilities sum to 1 across options.
Score probabilities sum to 1 across zero-based levels represented as string keys in JSON.
A Score value is the probability-weighted level position and can be fractional.

## Errors and retries

The source snapshot documents these statuses:

| Status | Meaning | Action |
| --- | --- | --- |
| `401` | Missing or invalid API key | Fix authorization; do not retry unchanged credentials |
| `422` | Invalid request body | Inspect field details and fix the request |
| `429` | Rate limit exceeded | Retry with exponential backoff |
| `529` | Service overloaded | Retry with exponential backoff |

Use bounded retries with backoff and jitter for transient failures.
Do not retry validation or authentication failures unchanged.
The official SDKs provide a default retry policy, but verify current behavior in the installed version.
Log request IDs or error metadata returned by the service without logging secrets or sensitive state.
