# Python SDK

Use the official `typesafe-sdk` package for synchronous or asynchronous Python calls.
Confirm details against the installed package types when exact options, retries, exceptions, or version-specific behavior matter.

## Install and configure

```sh
uv add typesafe-sdk
```

Set `TYPESAFE_API_KEY` in the server environment.
Do not place the key in source code or client-side applications.

## Synchronous client

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

questions = {
    "billing": Noul(
        instructions="Is `document` about billing?",
    ),
    "tone": Choice(
        instructions="What is the customer's tone in `document`?",
        criteria={
            "calm": None,
            "frustrated": None,
            "angry": None,
        },
    ),
    "urgency": Score(
        instructions="How urgent is `document`?",
        criteria=["Can wait", "This week", "Today"],
    ),
}

with TypeSafeClient() as client:
    response = client.system_one(
        state={"document": "I was charged twice. Please fix this ASAP."},
        questions=questions,
    )

print(response.answers["billing"].noul)
print(response.answers["tone"].choice)
print(response.answers["urgency"].score)
```

The model argument is optional in the SDK source snapshot and defaults to `jev-latest`.
Pass it explicitly when the application must pin or select a model.

## Asynchronous client

```python
from typesafe_sdk import AsyncTypeSafeClient, Choice


async def classify(message: str) -> str:
    async with AsyncTypeSafeClient() as client:
        response = await client.system_one(
            state={"message": message},
            questions={
                "route": Choice(
                    instructions="Which route fits `message`?",
                    criteria={
                        "billing": "Payments and refunds",
                        "technical": "Bugs and integrations",
                        "other": "Neither supplied route fits",
                    },
                )
            },
        )

    return response.answers["route"].choice
```

## Read typed answers

Answers are available by ID through `response.answers`.
The source snapshot also documents grouped mappings:

```python
response.nouls["billing"].noul
response.choices["tone"].choice
response.scores["urgency"].score
```

Choice and Score answers include `probabilities` and `confidence`.
Score answers also include `legend`.
The Python SDK uses integer keys for Score probability and legend mappings, while raw JSON uses string keys.

## Operational guidance

- Reuse client lifecycle patterns supported by the installed SDK instead of constructing unnecessary clients per item.
- Batch independent questions that share state into one `system_one` call.
- Keep retries bounded and inspect the installed SDK's `RetryPolicy` when defaults matter.
- Catch SDK-specific authentication, validation, rate-limit, connection, and timeout exceptions at the application boundary.
- Log usage and failures without recording credentials or sensitive state.
- Validate question thresholds on target data.

See [Question design](../question-design.md) for question construction and [Composition patterns](../composition-patterns.md) for batching and routing.
