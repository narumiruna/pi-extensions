# Terminal and provider verification handoff

This checklist retains the unverified checks from completed UI changes after removal of their historical implementation reports. Automated rendering, headless loading, and Linux PTY smokes do not establish physical-terminal acceptance or live-provider compatibility.

## Physical-terminal review

A maintainer or tester needs the built local packages in the target terminal, theme, and operating system. Use synthetic data and disposable settings or profiles for save/apply checks. Follow the [local development instructions](../../README.md#-local-development) before loading a package.

| Area | Action and expected result |
| --- | --- |
| Ticker, Chat, and Files editor widgets | Check regular/fullscreen placement, palette changes, narrow resizing, and Chat dock height. The standard separator and bounded content must remain visible without changing editor input. |
| Starship configuration chat | Check the main menu, inline Configuration summary, editor input, IME, resizing, save/discard, and return to the parent session. Follow the current [configuration chat runtime checklist](../../packages/pi-starship/docs/configuration-chat-runtime.md). |
| Subagents widget | Check task-first rows, thinking shown only when it differs from the captured parent default, saved display overrides, narrow layouts, and resizing. Rows must remain readable and bounded without changing editor input. |
| Plan questions | Answer a question, then expand its result. Questions, answers, and notes must remain readable, with complete expanded text when graphemes fit the viewport. |
| Starship individual statuses | With a disposable profile, inspect usage beside Provider/Model, sync on the last optional line, absent-status line collapse, and per-key colors at normal and narrow widths. |
| Goal waiting display | Review recorded or synthetic `goal_wait` output in collapsed and expanded form with the normal theme and statusline. The footer must stay short, the tool block readable, and full details accessible through expansion and Goal status. |

Physical appearance, font metrics, color readability, IME behavior, and non-Linux platform behavior remain unverified for these changes. These external reviews are not new coding-plan completion gates.

## Live-provider review

An authorized provider account owner needs working Pi authentication and explicit approval to spend quota. Run a short Starship configuration conversation with the selected provider. Confirm that read/write/edit interoperate and that explanations use the immutable chat-opening snapshots rather than treating draft previews as saved or live state.

Local deterministic providers establish routing and prefix stability, not real-provider tool interoperability or answer quality. Stop after one clear external or entitlement failure instead of retrying automatically. Do not claim live-provider compatibility before recording that result.

## Remaining verification limits

- Chat's generated Jiti smoke opens its lazy menu; it does not mount the changed widget through a real packaged chat connection. Builder import validation and injected-transport widget tests do not establish that live path.
- Earlier macOS full-suite attempts encountered a Fleet Unix socket path-length failure, two long-path Edit Scope rendering failures, and a Unicode-filename assumption. The path-length cases passed with a shorter temporary root, but the Unicode case remained. Linux success does not establish that the macOS suite is green.
- An earlier full-suite attempt intermittently failed Subagents' startup-model assertion in `packages/pi-subagents/test/model-selection-runtime.test.ts`. Unchanged focused reruns and a subsequent full Linux run passed; this cleanup does not establish that the intermittent cause is fixed.
- Registry publication, mixed installed-version behavior, physical-terminal acceptance, and platform coverage are separate claims. This checklist records no new test execution or dependency-security assessment.

A maintainer with the affected environment owns investigation of the platform and intermittent-test limits above. Use the repository-pinned toolchain and unchanged regression assertions, record the result, and retain any unresolved limitation rather than treating a passing rerun as proof of a fix.

## Compatibility and release restrictions

Before returning to a Starship release without individual `${extension_status.<raw-key>}` references, restore an earlier TOML/profile or remove those references. No producer-key migration or automatic user-document rewrite is required.

No provider request, package publication, visibility change, version tag, or release workflow is authorized by this checklist. Publication still requires explicit user approval; automated checks and this documentation cleanup do not establish release readiness.
