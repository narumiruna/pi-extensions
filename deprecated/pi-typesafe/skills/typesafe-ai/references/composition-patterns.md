# Composition patterns

Use these patterns after defining the state and individual questions.
Read [Question design](question-design.md) first when the primitive or criteria are not settled.

## Speculative fan-out

Send independent questions over the same state in one request, including branch-specific questions.
State each branch premise inside the question because questions cannot see one another's answers.
Let code consume only the answers relevant to the selected branch.

```python
questions = {
    "category": Choice(
        instructions="Which category best fits the ticket?",
        criteria={
            "bug": "A broken or failing feature",
            "billing": "Charges, invoices, or refunds",
            "feature": "A request for new functionality",
        },
    ),
    "bug_severity": Score(
        instructions="If the ticket reports a bug, how severe is it?",
        criteria=[
            "Cosmetic",
            "Degraded with a workaround",
            "Blocking with no workaround",
        ],
    ),
    "refund_requested": Noul(
        instructions="Does the ticket explicitly request a refund?",
    ),
}
```

```python
category = response.answers["category"].choice

if category == "bug":
    route_bug(response.answers["bug_severity"].score)
elif category == "billing":
    route_billing(response.answers["refund_requested"].noul)
```

This avoids a second round trip when all questions can use the original state.
Do not use fan-out when the first answer must fetch evidence, construct new content, or determine a candidate set for the next question.

## Composite scoring

Split a broad ranking judgment into independent Score questions.
Normalize each score to 0–1 before combining scales of different lengths.
Keep the weights in code so policy remains inspectable and adjustable.

```python
severity = answers["severity"].score / 2
frustration = answers["frustration"].score / 2
report_quality = answers["report_quality"].score / 3

priority = 0.6 * severity + 0.3 * frustration + 0.1 * report_quality
```

Weighted sums fit compensating preferences, where strength in one dimension can offset weakness in another.
They do not fit hard constraints such as “escalate if any serious violation is present.”
Represent hard constraints with separate Noul or Choice answers and explicit code.

Preserve raw answers and distributions when weights, thresholds, or display filters may change later.
Policy changes then do not require another model call when the evidence and question meanings are unchanged.

## Confidence-gated routing

Match uncertainty handling to the consequence of each action.
Use conservative behavior for destructive or high-stakes branches.

```python
answer = response.answers["route"]

if answer.confidence < 0.6:
    send_to_manual_triage()
elif answer.choice == "read_only":
    show_result()
elif answer.choice == "write_action" and answer.confidence >= 0.9:
    ask_user_to_confirm()
else:
    request_clarification()
```

Confidence describes the answer distribution, not end-to-end correctness or permission to act.
Choose thresholds from labeled examples and application consequences.
An ambiguous harmless preference can tolerate lower confidence than a financial, safety, or destructive action.

## Cascades

Use a cascade when a cheaper first stage can handle common cases and a stronger system should receive uncertain or failing cases.
A typical flow is:

1. Produce a candidate result with code or a fast model.
2. Ask narrow grounded verification questions.
3. Apply an explicit escalation rule such as any critical flag above its threshold.
4. Send only escalated cases to a human or reasoning model.
5. Measure quality, escalation rate, latency, and cost together.

Do not average away a serious isolated failure.
Use a max-style or explicit-any gate when one failed field is sufficient to escalate.
See [Verification and learning](cookbooks/verification-and-learning.md#structured-data-extraction-cascade).

## Reusable semantic features

Choice probabilities, Noul values, and normalized Scores can become reusable data columns.
Code can rerank, filter, or visualize them without rerunning inference.
With labeled outcomes, a classical model can learn how to combine the semantic features.
Keep a held-out set and evaluate whether added features improve target performance rather than merely fitting training data.
