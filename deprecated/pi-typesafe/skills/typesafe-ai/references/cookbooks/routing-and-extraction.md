# Routing and extraction

Use these patterns when code owns a known schema or candidate set and TypeSafe supplies semantic selection.

## Function calling

Use TypeSafe to map a natural-language request onto ordinary typed functions when function names and important arguments come from closed sets.

### Decomposition

1. Inspect function signatures and identify closed-set arguments such as enums, `Literal` values, or sets of those values.
2. Write a Choice question for the function name.
3. Write branch-specific Choice or Noul questions for every closed-set argument.
4. Ask the function and argument questions together against the original request.
5. Read only the arguments for the selected function.
6. Apply defaults, schema validation, authorization, and execution in code.

Descriptions must connect user language to code values.
A type such as `Literal["1mo", "3mo"]` does not explain that “this quarter” maps to `3mo`.
Put that semantic mapping in criteria.

```python
questions = {
    "function": Choice(
        instructions="Which supported function should handle `request`?",
        criteria={
            "price_history": "Show prices for one symbol over a period",
            "rolling_correlation": "Compare rolling correlation for two symbols",
            "none": "No supported function matches",
        },
    ),
    "correlation_window": Choice(
        instructions=(
            "If `request` asks for rolling correlation, which window does it specify?"
        ),
        criteria={"20d": "About one trading month", "60d": "About one quarter"},
    ),
}
```

TypeSafe does not generate arbitrary missing strings or numbers.
Parse free-form values with deterministic code, select from candidates, request clarification, or use another bounded extraction step.
Never execute a selected function before ordinary permission and argument checks pass.

A useful call-level uncertainty measure is the least certain answer actually consumed by the chosen call.
Do not multiply every answer probability blindly because products shrink with the number of arguments and answer a different question.

## Pre-parsed value extraction

Use deterministic parsers to find source spans, then use TypeSafe to select the span that matches the user's intent.
Code copies and normalizes the selected source value instead of asking a model to retype it.

### Pipeline

1. Over-find candidate spans with a regex, parser, database query, or exact lookup.
2. Deduplicate candidates while preserving their source form and location.
3. Add a `none` option when no candidate may fit.
4. Ask a Choice question whose options are the candidate IDs or values.
5. Copy the chosen source span exactly.
6. Normalize and validate it with deterministic libraries.
7. Route no-match or uncertain cases to clarification or review.

Examples include selecting the intended email among headers and body text, choosing the mobile phone number before E.164 normalization, or selecting the total due among several monetary amounts.
Separate selection from related classifications such as country, currency, or whether an amount is a credit.

The model cannot recover an omitted candidate.
Treat candidate recall as a separate measurable part of the system.
When the candidate count exceeds the API limit or becomes hard to distinguish, first select a section and then select a span within that section.

## Structure recovery

Recover formatting from plain text in stages when later units do not exist until earlier judgments are applied.

### Two-pass pipeline

1. Ask one narrow Noul question for each adjacent line pair, such as whether the second line continues the first mid-sentence.
2. Merge lines into blocks in code using a threshold evaluated on sample documents.
3. Ask a Choice question for each resulting block type, such as heading, paragraph, list item, code, or callout.
4. Ask useful companion questions in the same second pass, such as whether a list item is ordered.
5. Render Markdown deterministically from block labels and companion answers.

Two requests are justified because the blocks classified in pass two do not exist before pass one merges the lines.
Do not ask a broad “reconstruct this document” question when code can preserve text exactly and use typed judgments only for boundaries and labels.

Choose boundary questions that describe the local fact being judged.
For example, “does this line continue mid-sentence?” is less ambiguous than “are these lines in the same paragraph?” when unmarked list items appear as consecutive short lines.
Inspect low-confidence blocks rather than forcing a label silently.

## Shared checks

- Measure candidate coverage before evaluating selection accuracy.
- Include explicit no-match outcomes where appropriate.
- Preserve original source values and provenance.
- Validate normalized values and function arguments in code.
- Test ambiguous requests, omitted arguments, defaults, multiple matching values, and unsupported actions.
- Keep side effects behind application authorization and confirmation rules.
