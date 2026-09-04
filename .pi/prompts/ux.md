---
description: Redesign an existing interface around user goals
argument-hint: "<target or requirements>"
---

Redesign target and requirements:

$ARGUMENTS

If no concrete target or requirements were provided, ask for them and stop.
Redesign the interface for its actual users, platform, workflows, and constraints.
Improve the existing product rather than mechanically copying another interface's labels, visuals, or structure.

## Research before proposing changes

1. Read the repository instructions and inspect the current interface, implementation, tests, documentation, design conventions, and compatibility constraints.
2. Base user groups, goals, task frequency, and constraints on user-provided or inspected evidence.
   Distinguish observed facts from assumptions, and ask one focused question only when missing evidence would materially change the design.
3. Identify the primary user groups, their main goals, and the tasks they perform most often.
4. Walk through the current flows and record friction, unnecessary steps, inconsistent behavior, unclear state, and risky failure modes.
5. Classify capabilities as primary, secondary, advanced, destructive, or compatibility-only.
   Use these labels to guide priority and presentation, not to automatically create separate interface layers.
6. Evaluate each flow by frequency, importance, complexity, risk, and reversibility.
7. Document the current behavior for loading, empty, partial, success, error, disabled, cancellation, and recovery states.
8. Identify supported screen sizes, input methods, accessibility needs, stored-data constraints, and migration risks.

## Design principles

- Organize the experience around user goals and workflows rather than internal settings, data structures, or implementation details.
- Prioritize a small number of frequent and important actions.
- Keep decision-relevant state visible and provide immediate, specific feedback after actions.
- Use progressive disclosure for uncommon, complex, or risky controls.
- Keep related options in one flat group when there are seven or fewer.
  Split a larger group only when it improves scannability or supports meaningfully different workflows.
- Do not create separate basic and advanced areas solely because some options are less common.
  Prefer clear ordering, labels, and visual hierarchy for small groups.
- Keep navigation shallow and always provide an obvious way to go back, cancel, or exit.
- Offer a small set of meaningful defaults or presets where useful while preserving expert customization.
- Preview the concrete effect of consequential choices before applying them.
- Clearly distinguish previewing, confirming, cancelling, saving, and applying.
- Apply confirmed changes atomically and ensure cancellation has no side effects.
- On failure, preserve the previous valid state and show an actionable error with a recovery path.
- Preserve compatible workflows, stored user data, and unknown configuration fields where applicable.
- Prevent overflow, ambiguous truncation, hidden critical information, and disruptive layout shifts.
- Use consistent terminology, labels, navigation, feedback, confirmations, and cancellation behavior.
- Remove unnecessary steps without weakening safeguards for destructive or high-risk actions.
- Support the platform's relevant accessibility requirements, including keyboard navigation, focus management, screen readers, contrast, and non-color cues.

## Proposal and approval

Before modifying files, present:

1. The user groups, goals, constraints, and most important findings.
2. The revised information architecture and primary interaction flows.
3. The behavior for loading, empty, partial, success, error, disabled, cancellation, and recovery states.
4. Concrete acceptance criteria for behavior, responsiveness, accessibility, compatibility, and data preservation.
5. The proposed test strategy.
6. The main design decisions, alternatives, trade-offs, risks, and migration needs.

Wait for explicit approval before implementation.

## Implementation and verification

After approval:

1. Inspect the working tree and preserve unrelated or pre-existing changes before editing.
2. Implement the approved design using the product's established components and conventions where appropriate.
3. If the scope, design, risk, or acceptance criteria materially change, update the proposal and wait for explicit approval before continuing.
4. Keep state transitions, confirmations, cancellation, failures, and persistence behavior explicit and safe.
5. Render and exercise the primary flows at the supported screen sizes and input methods when practical.
   Inspect layout, overflow, clipping, focus, responsive behavior, accessibility, and loading, empty, partial, success, error, disabled, cancellation, and recovery states; record direct evidence or state the specific unverified paths.
6. Add or update tests for primary flows, previews, confirmations, cancellations, navigation, failures, responsive behavior, accessibility, and compatibility as applicable.
7. Update user-facing documentation when behavior or workflows change.
8. Run focused verification and all required repository checks.
9. Compare the result with every acceptance criterion and inspect the final diff for regressions or unrelated changes.
10. Summarize the implemented experience, direct verification evidence, trade-offs, and any unverified paths.
