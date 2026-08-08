# Apple HIG-Derived Interface Baseline

Use the product posture in this reference as cross-platform design philosophy. Read the detailed baseline when a task benefits from deeper HIG-derived reasoning, or when the target includes an Apple platform. Translate universal principles into the target platform's conventions; do not copy Apple-specific metrics, controls, or interaction patterns onto other platforms by default. This reference summarizes the repository archive captured from Apple’s Human Interface Guidelines; it does not replace platform-specific specifications.

When the archive is available, treat it as the source of truth:

```text
docs/human-interface-guidelines/data/design/human-interface-guidelines/<topic>.json
https://developer.apple.com/design/human-interface-guidelines/<topic>
```

The archive’s `manifest.json` records the source URL, capture time, complete page list, and file hashes. For a changed or platform-specific question, inspect the relevant JSON — or the current upstream page when freshness matters — rather than relying only on this summary.

## Product Posture

Apply the HIG design principles as decision criteria:

- **Purpose:** Optimize for the product’s genuine use and prioritize the features people came to use.
- **Agency:** Get people to their task, let them explore without lock-in, provide clear exits, and make mistakes recoverable without losing time or work.
- **Responsibility:** Explain permissions and data use honestly; collect only what the feature needs.
- **Familiarity:** Reuse known concepts, platform patterns, and consistent interactions; provide clear feedback.
- **Flexibility:** Design inclusively from the start, preserve context across configurations, and support multiple input methods.
- **Simplicity:** Include what is necessary and keep important things close. Simplicity is not minimalism.
- **Craft:** Prototype, test in real settings, iterate, and keep pace with platform conventions.
- **Delight:** Express character without obstructing the task; decoration alone is not delight.

## Non-Negotiable Interaction Baseline

### Accessibility

- Never use color, sound, motion, a gesture, or spatial position as the only way to communicate essential information or invoke core functionality.
- Support text enlargement and let layout reflow without losing useful content, hierarchy, or actions. Minimize truncation at large text sizes.
- Maintain adequate contrast in light, dark, and increased-contrast appearances. Prefer semantic system colors on Apple platforms.
- Give controls sufficient hit area and spacing. On Apple platforms, use at least `44×44 pt` for common controls and `60×60 pt` in visionOS unless a component’s platform guidance is stricter.
- Label elements for assistive technologies and preserve a logical reading and focus order.
- Support keyboard-only and alternative-input operation where the platform provides it. Do not override familiar system shortcuts without a strong reason.
- Provide visible alternatives to gestures, especially custom, multifinger, timed, or hidden gestures.
- Avoid timed auto-dismiss for information people may need to process. Prefer explicit dismissal.
- Respect Reduce Motion, larger text, increased contrast, dark appearance, and other systemwide preferences.

### Layout and Adaptation

- Group by user intent; use spacing, alignment, and reading order to reveal relationships before adding containers.
- Place essential information early in the reading order, accounting for right-to-left languages.
- Differentiate controls from content and leave enough space for both recognition and operation.
- If content is hidden, signal that more exists through a familiar disclosure control, partial continuation, or another visible cue.
- Preserve recognizable structure across viewport sizes, orientations, resizable windows, localization, text expansion, and connected inputs. Adapt the layout rather than shrinking it indiscriminately.
- Test the smallest and largest supported layouts, the largest text sizes, long translated strings, empty and dense data, and all supported orientations.

### Actions and Controls

- Use the most prominent style for the most likely nondestructive action; generally limit prominent actions to one or two per view.
- Distinguish preferred actions by style, not arbitrary size differences among related buttons.
- Use a short verb label when it communicates more clearly than an icon. Use familiar symbols only for familiar meanings.
- Expose pressed, focused, selected, disabled, loading, success, and error states as applicable.
- Never assign the primary/default role to a destructive action. Make destructive consequences explicit and provide cancellation, undo, or confirmation proportional to reversibility and intent.
- Keep task-specific options with the task. Put only general, infrequently changed options in settings.

### Feedback, Errors, and Loading

- Match feedback prominence to consequence: keep routine status near the affected object; interrupt only for critical, actionable information.
- Use alerts sparingly. Do not interrupt merely to report nonactionable information or a common undoable action.
- Explain why an action is unavailable or failed and give a concrete recovery path. Place validation near the problem and avoid blame.
- Confirm completion only when the action is significant enough that uncertainty would matter.
- Show useful structure or placeholders quickly. For delays longer than a moment, communicate progress; use determinate progress when duration is knowable.
- Keep unaffected work available during background loading when possible.

### Modality, Onboarding, and Help

- Use modality only when focus, a consequential choice, or a narrowly scoped task clearly benefits. Keep modal tasks short, preserve context, provide an obvious dismissal path, and do not stack modals.
- Protect unsaved work when dismissing a modal flow.
- Prefer an interface people can learn by using. Teach in context and through interaction.
- Keep prerequisite onboarding brief; make tutorials optional and findable later. Do not front-load features people must memorize.
- Provide useful defaults and postpone nonessential setup, permissions, ratings, and purchase prompts until intent makes them relevant.
- Keep tips short, actionable, dismissible, audience-targeted, and near the feature they explain.

### Writing and Privacy

- Put the most important information first. Use plain, concise, inclusive, action-oriented language and consistent terminology.
- Label actions with specific outcomes. Avoid vague labels such as “OK” when a verb like “Delete,” “Send,” or “Retry” is clearer.
- Give empty states a contextual next step, but do not place crucial information in a state that disappears once content exists.
- Request only the data or capability a feature needs, at the moment a person demonstrates intent. Explain the benefit in a brief, specific, truthful sentence.
- Respect denial and systemwide privacy choices; do not use visual manipulation to steer permission decisions.

### Motion

- Use motion to explain continuity, causality, or feedback, not as ornament that delays repeated work.
- Keep feedback animation brief and precise, track direct gestures naturally, and let people interrupt or cancel motion.
- Do not make motion the only carrier of meaning. Provide reduced or nonmoving alternatives.

## HIG Topic Map

Inspect these archived pages when the issue is material:

| Decision | Archived topic slug |
| --- | --- |
| Product principles, agency, recovery, simplicity | `design-principles` |
| Contrast, Dynamic Type, input alternatives, Reduce Motion | `accessibility` |
| Grouping, hierarchy, progressive disclosure, adaptation | `layout` |
| Semantic color, appearance variants, color-independent meaning | `color` |
| Legibility, text hierarchy, scaling and reflow | `typography` |
| Labels, empty states, errors, form hints | `writing` |
| Status, confirmations, warnings, feedback channels | `feedback` |
| Modal scope, dismissal, stacked-modal risk | `modality` |
| Purposeful, cancellable, reduced motion | `motion` |
| Perceived wait and progress communication | `loading` |
| Optional, contextual learning and setup deferral | `onboarding` |
| Defaults and task-specific versus global options | `settings` |
| Data minimization and just-in-time permission requests | `privacy` |
| Action prominence, target size, labels, destructive roles | `buttons` |
| Interruption threshold, copy, and action labeling | `alerts` |
| Contextual tips and tooltips | `offering-help` |

For Apple-specific work, also inspect `designing-for-ios`, `designing-for-ipados`, `designing-for-macos`, `designing-for-tvos`, `designing-for-visionos`, or `designing-for-watchos`, plus the exact component topic.

## HIG-Informed Review Questions

1. Does the design get people to their purpose and preserve their agency, context, work, and ability to recover?
2. Is “simplicity” reducing total effort, or only removing visible cues and controls?
3. Can core content, actions, status, and recovery be perceived and operated without relying on one sense or input method?
4. Does the hierarchy survive large text, long localization, right-to-left reading, narrow and wide layouts, and dense data?
5. Is the primary action the most likely nondestructive action, with no more than one or two prominent choices?
6. Is feedback local and proportional, and are interruptions reserved for critical actionable information?
7. Are loading, empty, error, disabled, permission-denied, offline, and success states designed rather than omitted?
8. Are modal flows short, dismissible, and protected from accidental data loss?
9. Are defaults useful, settings minimal, help contextual, and requests deferred until intent is clear?
10. Which platform convention or HIG topic supports each nonobvious decision, and what evidence justifies a deviation?
