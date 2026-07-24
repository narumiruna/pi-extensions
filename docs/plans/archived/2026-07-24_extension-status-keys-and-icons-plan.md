# Extension status keys and third-party icon matching plan

## Goal

Define a repository-wide status-key convention for extension authors while keeping
`@narumitw/pi-statusline` open to arbitrary third-party Pi extensions.

Success means repository-owned status producers use a stable logical extension id with an optional
stable slot, third-party status keys remain opaque and exactly configurable, explicit namespace
wildcards and installed-package aliases are documented fallback conveniences, and existing
`pisync` / `unknown-error-retry` icon customizations continue to work after the canonical keys become
`sync` / `retry`.

## Context

Pi exposes `ctx.ui.setStatus(key: string, text: string | undefined)` and stores statuses in a shared
string-keyed map. Pi does not attach package provenance, validate a key grammar, or prevent two
extensions from overwriting the same key. Official Pi examples use short logical ids such as
`plan-mode`, `status-demo`, and `system-prompt`, but this is a convention rather than an enforceable
platform contract.

The repository currently has thirteen active status producers. Eleven already use the logical
unscoped package name with `pi-` removed; the exceptions are:

- `@narumitw/pi-sync`: package-derived id `sync`, emitted key `pisync`.
- `@narumitw/pi-retry`: package-derived id `retry`, emitted key `unknown-error-retry`.

`pi-statusline` already accepts arbitrary exact keys and heuristically maps installed package names
to package-derived status bases. It does not currently expose an explicit wildcard selector.
`pi-starship` independently renders the same Pi extension-status map and has equivalent package-alias
and icon behavior, so canonical key changes must remain visually compatible in both footer packages.

## Architecture

### Producer convention

Repository-owned extensions SHOULD use lowercase kebab-case keys with this grammar:

```text
<extension-id>
<extension-id>:<stable-slot>
```

`<extension-id>` is the unscoped package basename with a leading `pi-` removed. A single aggregated
status uses only the extension id. `:<stable-slot>` is reserved for independently owned statuses that
must coexist; transient states, tool-call ids, and other changing values belong in status text rather
than the key. Every producer clears the exact key it set and clears session-owned status during
shutdown or failed initialization.

This convention applies to repository-owned code and serves as guidance for third-party authors. It
is not enforced against external status keys, because Pi accepts arbitrary strings and exposes no
owner metadata.

### Consumer matching

Keep the existing flat `extensionStatusIcons: Record<string, string>` settings shape. Treat every
observed third-party status key as opaque and resolve an icon in this order:

1. Exact configured raw status key, including `""` suppression.
2. Longest explicit namespace wildcard ending in `:*`, where `foo:*` matches `foo:server` and deeper
   colon-delimited slots but not `foo`, `foobar`, or slash-delimited keys.
3. Existing unambiguous installed-package id/alias heuristic, retaining colon and slash matching for
   third-party compatibility.
4. A leading emoji supplied by the status text.
5. A built-in icon for known current or compatibility keys.
6. The footer-specific unmatched fallback (`🔌` in pi-statusline; configured `fallback` then `🔌` in
   pi-starship).

Package aliases remain best effort only. Documentation must state that Pi does not reveal which
package emitted a status, exact raw keys are the only universally reliable selector, and status-key
collisions have already occurred before either custom footer receives the map.

### Compatibility

- Change repository producers to emit only `sync` and `retry`; do not emit duplicate legacy statuses.
- New default documents and examples use canonical keys.
- When a pi-statusline document explicitly configures `pisync` or `unknown-error-retry` but omits its
  canonical replacement, use that explicit legacy value for `sync` or `retry`; a canonical explicit
  value wins when both are present. Do not rewrite user files merely to migrate these entries.
- Keep legacy built-in rendering for older independently installed pi-sync/pi-retry versions that
  still emit the old keys.
- Give pi-starship's `extension_status.icons` the equivalent legacy configured-key fallback and
  canonical built-in defaults.

## Non-Goals

- Change Pi's `setStatus()` API or infer authoritative package ownership from a status entry.
- Force third-party extensions to adopt this repository's key grammar.
- Prevent collisions between external extensions that emit the same raw key.
- Add general globbing, regular expressions, or wildcard forms other than a terminal `:*` namespace
  selector.
- Add extension-to-extension dependencies or a shared runtime package between pi-statusline and
  pi-starship.
- Rewrite existing user settings files automatically.
- Change status text, retry classification, sync behavior, or command names.

## Plan

- [x] Add focused failing tests in `extensions/pi-statusline/test/statusline.test.ts` and
  `extensions/pi-starship/test/modules.test.ts` for arbitrary exact third-party keys, `foo:*`
  namespace matching, longest-wildcard precedence, exact-key precedence, empty-string suppression,
  non-matches (`foo`, `foobar`, and `foo/server`), package-alias fallback, and each footer's existing
  final fallback; the red `npm test` run failed only the two new wildcard tests with `🔌 running`
  instead of the expected longest wildcard icon.
- [x] Implement explicit `:*` matching in
  `extensions/pi-statusline/src/extension-status.ts` and
  `extensions/pi-starship/src/modules/extension-status.ts` without cross-package dependencies;
  focused footer tests and the final repository test suite pass with prototype-safe own-property
  lookups and documented precedence.
- [x] Add settings regression tests in `extensions/pi-statusline/test/settings.test.ts` for canonical
  `sync` / `retry` defaults, legacy-only custom icon inheritance, canonical-over-legacy precedence,
  empty-string migration, unknown-field preservation, and no persisted rewrite; the red focused run
  failed the new default and legacy inheritance assertions before normalization changed.
- [x] Update `extensions/pi-statusline/src/settings.ts` so new defaults use `sync` and `retry`, include
  current repository status producers such as `accounts` and `google-genai`, and retain legacy
  runtime fallback without exposing duplicate legacy entries in a newly created document; focused
  settings tests and the final repository suite pass, including byte-for-byte no-rewrite coverage.
- [x] Add producer lifecycle tests in `extensions/pi-sync/test/sync.test.ts` and
  `extensions/pi-retry/test/retry.test.ts` proving active, transient, timer, and shutdown paths set and
  clear only `sync` or `retry`; the red producer run reported four legacy-key failures before source
  changes, while `[unknown-error-retry]` error-tag coverage remained unchanged.
- [x] Change `extensions/pi-sync/src/sync.ts` and `extensions/pi-retry/src/retry.ts` to emit the
  canonical keys without duplicate legacy statuses; focused producer tests and `npm run check` pass.
- [x] Update pi-starship's canonical/legacy built-in icon behavior and tests so both old independently
  installed producers and the new `sync` / `retry` producers retain their icons, while a canonical
  user icon overrides a legacy user icon; focused module tests and the full suite pass.
- [x] Expand the Status and persistent UI section of `docs/extension-conventions.md` with the
  `<extension-id>` / `<extension-id>:<stable-slot>` producer convention, exact-key cleanup rule,
  aggregation guidance, and the explicit statement that this is author guidance rather than Pi
  enforcement; reviewed wording preserves repository MUST/SHOULD authority.
- [x] Update `extensions/pi-statusline/README.md` with a dedicated “For extension authors” section
  explaining that pi-statusline cannot constrain third-party keys, exact raw matching is the reliable
  interoperability contract, the recommended key grammar is optional for external authors, and
  wildcard/package aliases are convenience fallbacks; reviewed exact, wildcard, package,
  suppression, and migration examples against passing tests.
- [x] Update `extensions/pi-starship/README.md` and affected default configuration examples to mirror
  the selector precedence and package-provenance limitation without implying that Pi identifies a
  status owner; reviewed all documented keys and wildcard examples against module tests.
- [x] Audit active `extensions/*/src` status producers with an ignore-independent search and confirm
  every repository-owned non-clear status key follows the convention or has a documented local
  exception; `rg --no-ignore -n 'setStatus|STATUS_KEY|ACCOUNTS_STATUS_KEY' extensions/*/src` found
  canonical logical ids for every producer, with only clear-only `statusline` and `starship` calls;
  no fragile validator was added.
- [x] Run `npm run check`, inspect the final diff for bounded changes to status producers, footer
  consumers, tests, conventions, and documentation, then archive this completed plan under
  `docs/plans/archived/`; the CI-equivalent gate passed all 1,178 tests before archival.

## Risks

- Status keys are a public integration surface even though Pi does not formally name them as one.
  Canonical producer changes can break user icon settings, so runtime legacy inheritance and tests
  are required before renaming emitters.
- Independently versioned packages may temporarily combine a new footer with an old producer or the
  reverse. Built-in compatibility keys must cover both combinations without rendering duplicate
  statuses.
- A wildcard can accidentally override a more specific rule. Exact keys and the longest matching
  wildcard must win deterministically.
- Installed package aliases remain heuristic and ambiguous when multiple packages derive the same
  logical id. Existing ambiguity rejection must remain intact, and docs must not promise provenance.
- pi-statusline and pi-starship duplicate footer behavior by package-boundary design. Parallel tests
  are required to prevent their selector semantics from drifting.

## Rollback / Recovery

If canonical producer keys cause an unhandled compatibility regression, revert the pi-sync/pi-retry
emitter changes while retaining exact third-party matching tests and documentation corrections.
User files are not rewritten, so rollback does not require data restoration. If wildcard semantics
prove ambiguous, remove only the `:*` matcher and its documentation while preserving exact raw-key
support and package aliases.

## Completion Checklist

- [x] Repository-owned emitters use stable logical ids, with `sync` and `retry` replacing the two
  known exceptions and no duplicate legacy statuses.
- [x] Arbitrary third-party raw keys remain exactly configurable without package installation or key
  validation.
- [x] `foo:*` matching is explicit, delimiter-bound, longest-match deterministic, and lower priority
  than an exact key in both footer implementations.
- [x] Package aliases remain documented and tested as best-effort fallbacks rather than authoritative
  ownership.
- [x] Existing `pisync` and `unknown-error-retry` icon customizations and older producer versions keep
  rendering correctly, while new documents use canonical keys.
- [x] pi-statusline documentation clearly tells users and extension authors that the grammar is a
  convention, not enforcement, and that exact raw status keys are the reliable contract.
- [x] Repository conventions, pi-starship documentation, defaults, and tests agree with the final
  behavior.
- [x] `npm run check` passes and the completed plan is archived with all 1,178 tests passing.
