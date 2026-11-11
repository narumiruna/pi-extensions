# JavaScript SDK

Use `@typesafe-ai/sdk` for JavaScript or TypeScript integrations.
The source snapshot requires Node.js 20 or newer.
Confirm exact exports and options against the installed package types when version-specific behavior matters.

## Install and configure

```sh
npm install @typesafe-ai/sdk
```

Set `TYPESAFE_API_KEY` in the server environment.
Do not expose the key in browser code.

## Quickstart

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();

const response = await client.systemOne({
  state: {
    document: "I was charged twice. Please fix this ASAP.",
  },
  questions: {
    category: choice("What is `document` about?", {
      billing: "Payments and refunds",
      technical: "Bugs and integrations",
      other: "Neither supplied category fits",
    }),
  },
});

console.log(response.answers.category.choice);
console.log(response.answers.category.probabilities);
console.log(response.answers.category.confidence);
```

Answer types are inferred from the supplied questions.
The package includes ESM, CommonJS, and TypeScript declarations.
Use the installed declarations as the authoritative reference for client configuration, retry policy, logging, request options, and helper signatures.

## Operational guidance

- Keep API calls in trusted server-side code.
- Batch independent questions over the same state.
- Preserve inferred answer types instead of weakening them with broad casts.
- Handle authentication, validation, rate-limit, timeout, and connection failures at the application boundary.
- Keep retries bounded and use the SDK's current retry policy rather than implementing conflicting nested retries.
- Log usage and failures without recording credentials or sensitive state.

See [Question design](../question-design.md) for primitive selection and [Composition patterns](../composition-patterns.md) for batching and confidence gates.
