# Verification and learning

Use these patterns to check artifacts against evidence or turn repeated semantic judgments into features for another model.

## Citation verification

Separate exact source checks from semantic support checks.
A citation can quote real text and still fail to support the claim.

### Pipeline

1. Normalize harmless formatting differences such as whitespace and curly quotes.
2. Search the authoritative source for the quoted text with deterministic code.
3. Mark an absent quote as fabricated without a model call.
4. Retrieve enough surrounding source context for a support judgment.
5. Ask a Choice question with outcomes such as `verified`, `contradicted`, and `unsupported`.
6. Use confidence and action risk to accept, flag, or route the result for review.

Suggested distinctions:

- `verified`: the source context supports the claim as stated.
- `contradicted`: the source context states the opposite or makes the claim false.
- `unsupported`: the quote is real, but the source does not establish the claim.
- `fabricated`: deterministic search cannot find the quote in the cited source.

Keep the claim, exact quote, source identity, section, and surrounding context in named state fields.
Do not ask the model to verify a citation without the source evidence.
Test paraphrases, partial support, omitted qualifiers, wrong sections, and fabricated quotes.

## Structured-data extraction cascade

Use a cheap extractor for common cases, TypeSafe for grounded verification, and a stronger extractor only for flagged cases.

### Pipeline

1. Extract a schema-conforming record with a low-cost model or parser.
2. Put the source, schema meaning, and extracted fields into state.
3. Ask one narrow Noul per failure mode or field, phrased so high probability means something is wrong.
4. Optionally ask a separate holistic question, but keep field signals visible.
5. Escalate when any critical field flag exceeds its evaluated threshold.
6. Re-extract or review only escalated records.
7. Validate the final schema and semantic result in code.

Example verifier questions include:

- Is this field unsupported by the source?
- Does this date conflict with the source text?
- Did the extraction omit a required value that is present?
- Does this field include navigation or boilerplate rather than page content?

Use a max-style or explicit-any gate when one wrong field is enough to invalidate a record.
An average can hide a severe isolated failure.
Schema validation catches structural errors but not hallucinated or semantically wrong values.

Measure end-to-end extraction quality, false escalation, missed failures, latency, and total cost.
Do not reuse cookbook thresholds or model-specific results without target-domain evaluation.

## Feature discovery

TypeSafe answers can convert free text into numeric features for a supervised classical model.
Use this when labeled outcomes exist and the desired prediction depends on semantic properties not represented in structured columns.

### Feature shapes

- A Noul produces one probability feature for a binary property.
- A Score produces an ordered numeric feature and optionally level probabilities.
- A Choice can produce one-hot-like probability features across categories.

### Iterative workflow

1. Split data into train, validation, and held-out test sets before feature iteration.
2. Propose narrow questions from domain hypotheses or a bounded proposal model.
3. Evaluate every candidate question consistently over the text rows.
4. Train a classical model on the semantic features and any existing structured features.
5. Use cross-validation errors and feature importance to identify gaps, redundancy, or leakage.
6. Add, revise, or remove questions one change at a time.
7. Stop with a finite iteration and feature budget.
8. Report held-out performance only after the design loop is finished.

A candidate that appears rare in a small proposal sample can still be predictive.
Do not discard questions solely because a proposer thinks they are uncommon.
Let validation results determine whether a paid feature is useful.

### Safeguards

- Prevent target labels, post-outcome facts, and split identifiers from entering state.
- Cache answers by source content, question definition, and model version.
- Version every question because changing its meaning changes the feature.
- Compare against a baseline without semantic features.
- Inspect whether feature importance is stable across folds and subgroups.
- Treat generated feature proposals as hypotheses, not evidence.
- Recompute features when the source, question meaning, or selected model changes materially.

Preserve raw semantic features so application code can inspect why the downstream model changed its prediction.
