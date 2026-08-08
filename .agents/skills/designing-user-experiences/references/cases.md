# Interface Cases and Counterexamples

Use these examples as contextual precedents, not rigid templates. Match the underlying task and risk before reusing a pattern. Add future cases as paired examples with a reason.

## List or Dashboard Toolbar

**Prefer:** Keep the main create action, current scope, search, and active filters visible. Group infrequent import, export, and column configuration under clearly labeled secondary controls.

**Avoid:** Put search, filters, export, and create into one unlabeled overflow menu merely to produce an empty header. This increases search cost and hides the primary path.

## Catalog and Canonical Editor

**Prefer:** Give catalog and editing work distinct responsibilities. Let the catalog own browsing, search, sharing, deletion, and lifecycle management; let one canonical editor own spatial or otherwise specialized changes. Make `Open on map` or its equivalent a one-step handoff that carries the selected object and returns predictably.

**Avoid:** Mount the same full editor in both the catalog and workbench, or require a second `Edit` mode after opening the canonical editor. Duplicate editors create competing mental models, state synchronization risk, and redundant controls.

## Object Detail View

**Prefer:** Show identity, current status, essential metadata, and the next likely action near the top. Give each header layer a separate purpose — for example, object name, meaningful revision, and actionable validation near Save. Put long history, diagnostics, and specialized metadata in labeled sections or tabs while preserving object context.

**Avoid:** Reduce the page to a name and one button, forcing users through separate screens to understand status or consequences. Also avoid stacking synonymous labels such as `Draft route`, `New route`, and a generic draft instruction when they do not change the next decision.

## Settings

**Prefer:** Group settings by user intent, expose common settings first, provide search when the set is large, and place advanced controls behind a labeled section that previews its contents.

**Avoid:** Use a single “Advanced” drawer as a dumping ground for unrelated options. The interface looks shorter but becomes unpredictable.

## Destructive Actions

**Prefer:** Give a destructive action a clear text label in a predictable object-level location, but never make it the primary/default action. Match protection to intent and reversibility: offer undo for common deliberate deletion, and use explicit consequences plus cancellation or confirmation for unexpected, uncommon, irreversible loss.

**Avoid:** Hide deletion behind an ambiguous icon or gesture, make it the most prominent action, or interrupt with confirmation for every common undoable action.

## Feedback and Errors

**Prefer:** Keep routine status and validation near the affected object, state what happened, explain why when useful, and offer a concrete recovery action. Reserve alerts for critical, actionable information that justifies losing the current context.

**Avoid:** Show a generic “Error” alert, blame the person, report nonactionable information modally, or confirm routine success that people already expect.

## Loading and Empty States

**Prefer:** Show meaningful structure or available content promptly, communicate progress for perceptible delays, keep unrelated work usable, and give an empty state a contextual next action.

**Avoid:** Present a blank screen during loading, fake precise progress, block the entire interface for background work, or place crucial guidance only in an empty state that later disappears.

## Permission Requests

**Prefer:** Ask only for data the feature needs, after the person demonstrates intent, and explain the specific benefit in plain language. Preserve a useful denial path when the feature can degrade gracefully.

**Avoid:** Request unrelated permissions at launch, imitate a system prompt, obscure the consequences, or manipulate the visual hierarchy to steer consent.

## Forms

**Prefer:** Show required fields for the current step, preserve dependencies and validation near their inputs, and reveal conditional fields immediately after the answer that makes them relevant.

**Avoid:** Hide requirements, validation, or conditional consequences until submission. This shifts complexity into error recovery.

## Dense Expert Workflows

**Prefer:** Preserve comparison context, keyboard efficiency, bulk actions, and customizable density when repeated throughput is central to the task.

**Avoid:** Convert every row into a spacious card or move each edit into a separate detail page solely to look calm. Visual whitespace can create more scrolling and context switching.

## Mobile or Narrow Viewports

**Prefer:** Keep the primary task, essential status, and current location apparent. For a desktop picker/canvas/inspector workspace, show one primary region at a time behind explicit labels such as `Map`, `Choose`, and `Edit`, while keeping selection and draft state in shared ownership. Reflow at large text sizes instead of shrinking targets or truncating useful content.

**Avoid:** Stack every desktop region into one long mobile page, remount panels in a way that loses drafts, or treat an unlabeled hamburger or swipe gesture as a universal solution. Constrained space changes presentation, not the need for discoverability, readable text, accessible targets, or state continuity.

## Modal Tasks

**Prefer:** Use a modal only for a narrowly scoped task, consequential choice, or focus benefit; name the task, keep it short, provide an obvious dismissal path, and protect unsaved work.

**Avoid:** Put a navigation hierarchy inside a modal, stack one modal over another, hide dismissal behind a gesture, or use modality merely to attract attention.

## Onboarding and Help

**Prefer:** Let people experience the product quickly, teach one relevant action in context, make tutorials optional and findable later, and postpone nonessential setup.

**Avoid:** Front-load a feature tour people must memorize, repeatedly show skipped onboarding, explain standard controls, or require configuration that a useful default can avoid.

## Utility Typography Across Scripts

**Prefer:** In an operational interface that mixes Latin and CJK or other scripts, use a compatible, legible UI family across headings and body text. Reserve monospaced type for coordinates, identifiers, or technical values, and use decorative display type only when expression is a real product goal and the script pairing has been tested.

**Avoid:** Apply a decorative Latin display face to hierarchy labels while unsupported scripts fall back to an unrelated system font. The split makes one hierarchy feel like two visual systems and can make a dense tool harder to scan.

## Accessibility and Multiple Inputs

**Prefer:** Preserve meaning and operation across color, text, sound, motion, keyboard, touch, pointer, and assistive technology. Give controls adequate target size, focus order, labels, and visible alternatives to gestures.

**Avoid:** Encode status only in color, make swipe or hover the sole route to a core action, auto-dismiss essential information, or let large text destroy hierarchy and recovery paths.

## Adding a Case

Use this shape:

```markdown
## <Context or Pattern>

**Prefer:** <concrete structure or behavior> because <task benefit>.

**Avoid:** <specific counterexample> because <cognitive, discovery, context, or effort cost>.
```

Record the user, task, and environment when they materially affect the judgment. Revise an existing case instead of adding a near-duplicate.
