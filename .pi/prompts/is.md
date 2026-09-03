---
description: Investigate a GitHub issue and propose an implementation plan
argument-hint: "<issue URL or number>"
---

Issue: $ARGUMENTS

Follow this workflow:

1. Identify the issue from its URL or number.
   Use the current repository for a bare issue number, and ask if the target is missing or ambiguous.
2. Read the complete issue, including its description, discussion, linked context, labels, and current status.
3. Inspect the repository instructions, relevant code, tests, documentation, and history.
4. Classify the request and investigate it:
   - For a bug, treat the report, its diagnosis, and all discussion as unverified claims until supported by independent evidence.
   - Attempt to reproduce a bug before proposing a root cause or implementation plan. Start with the reporter's exact steps, then use the smallest focused reproduction available in the current repository.
   - Do not skip reproduction merely because it requires routine setup, dependency installation, building, or running existing tests.
   - Skip reproduction only when it would be unsafe or destructive, requires unavailable credentials, hardware, data, or external services, or has no actionable reproduction information. State the specific blocker instead of saying only that reproduction was impractical.
   - Record the relevant environment, commands or steps, inputs, observed behavior, and expected behavior. Label the result as reproduced, not reproduced, or not attempted.
   - If the bug is not reproduced, inspect code, tests, documentation, and history for corroborating or contradictory evidence. Clearly separate reporter claims, observed facts, and inferences; do not present the bug or suspected root cause as confirmed.
   - For a feature, identify the users, use cases, constraints, compatibility needs, and measurable acceptance criteria.
5. Define the scope, expected outcome, implementation approach, risks, and verification plan.
6. Present a concise implementation plan that begins with the reproduction result and supporting evidence for a bug.

This work does not modify files, branches, or issue metadata.
Do not claim reproduction, root cause, or passing checks without direct evidence.
