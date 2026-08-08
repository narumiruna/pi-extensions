---
name: explaining-step-by-step
description: Use when the user asks for a detailed, beginner-friendly, or step-by-step explanation; wants to understand how or why something works; asks to unpack a concept, issue, PR, code change, system, error, document, or technical decision; or says to explain it like teaching a child.
---

# Explaining Step by Step

Build the user's mental model from the big picture to the exact mechanism. Keep detail proportional to the question; detailed does not mean exhaustive.

## Ground the Explanation

1. Identify the question the user is actually asking and infer their starting point from context. Ask about background only when it would materially change the answer.
2. For code, errors, PRs, issues, or documents, inspect the available sources before explaining. Request only the minimum missing artifact when inspection is impossible.
3. Distinguish direct evidence from inference and unknowns. Never present a plausible cause as confirmed or infer an author's intent without support.

## Explain Progressively

Use only the layers that help:

1. **Orient:** State what the subject is and why it matters to the question.
2. **Prepare:** Define essential terms in plain language on first use.
3. **Decompose:** Put parts, events, or changes in a natural order.
4. **Connect:** Trace causality, data flow, control flow, state changes, or before/after behavior.
5. **Demonstrate:** Add the smallest example, excerpt, analogy, or calculation that exposes the mechanism.
6. **Qualify:** Include material limitations, risks, exceptions, or tradeoffs.
7. **Reinforce:** End with the few ideas worth remembering.

Adapt the sequence to the material: symptom → evidence → cause for errors; goal → before/after → execution flow for code changes; context → decision → consequences for documents. Cite relevant files, sections, hunks, logs, or tests when they help connect claims to evidence.

## Keep Examples Honest

- Walk through meaningful state changes rather than dropping in unexplained code or diagrams.
- For an analogy, say what maps to the real system and where the analogy stops.
- Simplify vocabulary and prerequisites, not the truth. Low assumed knowledge does not justify childish language or a false mental model.

## Pace and Boundary

Complete the useful simple-to-deep explanation in one response by default. Pause with one concrete question only when a material ambiguity, a user-requested staged lesson, or clear confusion makes the next step uncertain. Continue follow-ups from the current layer instead of repeating the introduction.

Honor requests for brevity, code only, or no explanation. This skill explains; it does not by itself approve, review, diagnose and fix, or modify an artifact. Combine it with the responsible workflow when the user requests those outcomes.
