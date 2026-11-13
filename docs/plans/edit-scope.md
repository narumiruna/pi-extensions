# Scope picker terminal acceptance

Status: the boundary fix is implemented and verified; the original physical-terminal acceptance criterion remains open. The active implementation is now in `pi-files`, not the retired `pi-edit-scope` package.

## Goal

Close the remaining terminal acceptance for non-wrapping marking: `Shift+Tab` stays on the first matching file, Tab stays on the last, and interior marking moves one result without changing raw identities or saved scope before Apply.

## Context

The fix landed in `57359372`; `01112a12` records the final audit, CLI smoke, and passing Linux CI. The original first-result regression failed before the correction, while the interior control passed. Afterward, 130 picker/marking/usability/host/UI tests passed, including filtered checks, repeated toggles, native input priority, remapped keys, legacy/enhanced input, and constrained regular/fullscreen hosts.

The original full macOS run had four reproduced baseline failures; the complete Linux gate passed with 19,215 tests and 16 skips. These are historical results, not current failures. During plan cleanup at repository baseline `01525ffe`, `npm run check` and full `npm test` passed: 947 files, 21,379 tests, 34 skips, and no unhandled errors.

The successor cutover retired `pi-edit-scope` in `1adf0067`. Current code is `packages/pi-files/src/scope/picker.ts`; regression coverage is in `packages/pi-files/test/picker-marking.test.ts` and `test/ui.test.ts`. Current loading and publication rules come from the Pi Files manifest and documentation, not the old private/source-loaded package.

Retained evidence and handoff:

- [Pi Files verification](../../packages/pi-files/docs/verification.md#retained-external-handoff) covers the active package and terminal limitations.
- [Historical boundary cases](../../deprecated/pi-edit-scope/docs/verification.md#physical-terminal-handoff) preserve the predecessor's detailed manual matrix.
- [PR #1810](https://github.com/narumiruna/pi-extensions/pull/1810) records the implementation audit and original verification.

## Plan

- [x] Reproduce and correct both marking boundaries without changing ordinary arrow wrapping, filtering, mouse identity, input priority, or draft-only scope publication. Evidence: the implementation commit and regression suites above.
- [x] Complete deterministic tests, root gates, CLI loading smoke, documentation review, and the semantic audit. Evidence: the recorded implementation verification and passing cleanup gates above; no physical-terminal claim is made.
- [x] Prepare the active-package terminal handoff below without running an interactive TUI from the agent shell.
- [ ] Record the maintainer's terminal results or explicit acceptance of the original limitation, then close this plan. Acceptance: the evidence names the tested environment and any remaining compatibility or release restriction.

## External Handoff

The terminal tester or maintainer owns this check. Build the active package, then run `pi --no-extensions -e ./packages/pi-files` in a real terminal and open `/scope`. In regular and fullscreen modes, check first/interior/last matches, filtering, repeated checking and unchecking, constrained height and resize, Apply, and cancellation. Confirm that only the intended file toggles and that boundary marking does not wrap.

Expected result: correct highlight, checked-file identities, native editing, and unchanged state after cancellation. Physical key delivery, IME, clipboard behavior, subjective usability, and interactive `/reload` remain unverified. Headless host tests do not substitute for them. The original criterion requires terminal evidence or an explicit maintainer-accepted limitation; neither is inferred from merging or successor migration. Publication and npm deprecation require separate approval.

## Applicable rules and verification

Follow `docs/extension-conventions.md` and the active package's guidance: keep TUI-only custom UI, bounded rendering, callback theme/keybindings, native editing and paste, hard cancellation, raw file identities, draft ownership, and lifecycle cleanup. Verify with picker/native-host `Test`, final-diff `Review`, both repository gates, and the separately recorded terminal `Smoke`. No implementation, settings, prompt, or package metadata change is authorized by this acceptance follow-up.

## Completion Checklist

- [x] The boundary fix, regression evidence, current source paths, and retained handoff are identified.
- [x] Passing deterministic/root verification is distinguished from historical baseline failures and physical-terminal evidence.
- [ ] The original terminal acceptance condition has a recorded disposition, with unverified behavior and release limits preserved before plan deletion.
