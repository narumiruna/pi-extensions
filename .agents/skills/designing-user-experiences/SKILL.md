---
name: designing-user-experiences
description: Design, review, or implement accessible user interfaces and end-to-end digital experiences, including screens, components, navigation, information architecture, workflows, system states, and interaction behavior. Use bounded surface mode for focused UI work; substantial cross-surface or product-level experience changes require an approved proposal before implementation.
---

# Designing User Experiences

Minimize cognitive load without sacrificing capability, agency, context, or recovery. Ground decisions in the product's actual users, workflows, platform, design system, and constraints. Apply Apple-derived principles through target-platform conventions rather than copying platform-specific controls or metrics.

Do not invent research, business rules, capabilities, defaults, frequency, risk, success claims, or implementation constraints. Label assumptions and unknowns; preserve current behavior where evidence is incomplete.

## Route by Scope and Request

- **Bounded surface:** a screen, component, form, dashboard, local navigation area, or contained workflow whose behavior and ownership are already understood. Follow the requested Proposal, Review, or Implementation mode without imposing an extra approval gate.
- **Substantial experience:** product-level information architecture, navigation model, multi-surface workflow, state model, capability classification, or redesign with material behavior, compatibility, persistence, or recovery decisions. Produce a proposal first and do not edit product files until the user explicitly approves it.

Ask one focused question only when a missing product decision blocks safe work. Otherwise preserve uncertain behavior and identify the unresolved decision.

## Establish Context

For a new product, inspect available briefs, research, requirements, domain rules, platform conventions, technical constraints, and accessibility requirements. Identify intended user groups, jobs, proposed capabilities, dependencies, cancellation and recovery paths, and measurable outcomes without implying that unbuilt behavior exists.

For an existing product, inspect the relevant interface, code, tests, user-facing documentation, stored formats, supported widths and inputs, accessibility conventions, and design system. Identify current users and jobs, inventory capabilities before simplifying, and map current paths, states, dependencies, cancellation, recovery, and compatibility requirements.

Classify capabilities and information by task necessity, evidence-backed frequency and importance, consequence if missed, complexity, risk, reversibility, and the search, memory, navigation, or recovery cost of hiding them:

| Class | Presentation |
| --- | --- |
| Primary | Direct, labeled, and prominent |
| Supporting | Visible with lower emphasis near its object |
| Contextual | Revealed for the relevant item, role, state, or step |
| Advanced | Labeled progressive disclosure or dedicated view |
| Safety/status | Visible at the relevant time; interrupt only when necessary |
| Redundant/irrelevant | Remove only after proving no capability, cue, status, or recovery path is lost |

Classification informs prioritization; it does not automatically require sections, pages, menus, or navigation levels.

## Shape the Experience

1. Put the user's primary job first and preserve exit, cancel, undo, and recovery.
2. Organize around user intent, dependency, decision sequence, and comparison needs rather than internal settings or data structures. Keep navigation and ownership shallow, terminology consistent, and handoffs clear.
3. Use reading order, grouping, spacing, typography, alignment, and contrast before decorative containers or color.
4. Keep consequential state, primary actions, required input, permission boundaries, destructive consequences, unsaved-work risk, and error recovery visible when they affect a decision.
5. Prefer clear labels, standard controls, persistent context, and familiar patterns over hidden gestures, hover-only actions, unexplained icons, or recall-heavy navigation. Do not transplant another product's labels, patterns, or information architecture without product evidence.
6. Use labeled, stable, shallow progressive disclosure for secondary or advanced capability only when its scanability benefit outweighs added navigation and memory cost. Never hide the sole accessible route to a core action.
7. Offer a small set of meaningful defaults or presets when supported while retaining expert customization.
8. Preview consequential choices and distinguish previewing, confirming, cancelling, saving, and applying through labels, state, and feedback. Never style a destructive action as the default or remove safeguards for hard-to-reverse actions.
9. Keep routine status near its object and reserve interruptions for critical, actionable, unexpected, or hard-to-reverse events.
10. Preserve recognizable hierarchy across supported widths, content extremes, text scaling, localization, right-to-left layout, permissions, and inputs.
11. Never make color, sound, motion, gesture, pointer, or position the sole carrier of meaning or access. Support relevant keyboard and focus behavior, assistive technology, target size, contrast, reflow, non-color cues, and reduced motion.
12. Audit both overload and false simplicity. Reject cleanup that increases search, navigation depth, repeated effort, uncertainty, context loss, hidden dependencies, or inaccessible interaction.

## Propose or Review

For a proposal, present the evidence-backed findings and assumptions, capability classification, proposed architecture and flows, loading/empty/success/error/disabled/partial states, acceptance criteria, trade-offs, risks, validation needs, unresolved decisions, and compatibility or migration requirements. Keep the structure proportional to scope.

For a review, lead with prioritized findings tied to user effort, risk, evidence, accessibility, or platform convention. Give each material finding a concrete correction and preserve sound existing behavior.

For substantial experience work, requested revisions update the proposal and do not imply implementation approval.

## Implement Within Authority

Implement a bounded surface only when implementation was requested. Implement a substantial experience only after explicit proposal approval. Preserve unrelated behavior, content meaning, data semantics, permissions, stored data, unknown configuration fields, and compatibility unless the authorized scope includes a verified migration.

- Apply confirmed changes atomically; cancellation has no side effects.
- On failure, retain the previous valid state and provide actionable recovery or retry guidance.
- Keep primary actions, status, validation, unsaved-work risk, and recovery visible at the relevant time.
- Preserve selection, drafts, context, and capability across navigation and progressive disclosure.
- Add or update proportionate tests and documentation for affected behavior when the repository uses them.

Exercise directly affected layouts, content densities, inputs, permissions, transitions, cancellation, failures, and loading, empty, success, error, disabled, or partial states that the product supports. Verify responsive behavior and accessibility with direct evidence; do not invent states merely to complete a checklist or claim environments that were not tested.

Stop when the requested surface or approved experience and its affected states are addressed. Report the result first, checks performed, preserved compatibility, material trade-offs, assumptions, and unverified scenarios.

Use `references/apple-hig.md` for deeper HIG-derived or Apple-platform decisions, `references/preferences.md` for adjustable visual defaults, and `references/cases.md` for comparable patterns. Product evidence, platform conventions, and accessibility override preferences.
