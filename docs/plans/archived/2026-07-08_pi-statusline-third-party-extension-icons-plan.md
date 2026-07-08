## Goal

Resolve [issue #153](https://github.com/narumiruna/pi-extensions/issues/153) by letting `@narumitw/pi-statusline` apply `extensionStatusIcons` overrides to arbitrary installed extension ids, including third-party package ids such as `@scope/pi-example`, while preserving existing status-key overrides like `goal` and `caffeinate`.

Success means users can configure icons by either the emitted status key or an installed extension package id/alias, and `pi-statusline` resolves the icon predictably for extension statuses shown in the footer.

## Context

`pi-statusline` currently formats statuses from `footerData.getExtensionStatuses()` and looks up `extensionStatusIcons` by the raw status key. That works for built-in/default keys but does not bridge package ids from Pi settings to status keys for third-party extensions.

Repository evidence:

- `extensions/pi-statusline/src/statusline.ts` already reads user/project settings in duplicate-extension detection via `readPackageSources()` and `packageNameForSource()`.
- `formatExtensionStatus()` currently receives only the status key, value, theme, and icon config.
- Existing tests cover exact-key overrides, leading emoji fallback, built-in defaults, and unknown fallback.

## Architecture

Add a small extension-id alias layer inside `pi-statusline`:

1. Load installed package names from the same settings sources already inspected for duplicate extension detection.
2. Derive status-key aliases from package names, e.g. `@scope/pi-foo` → aliases `@scope/pi-foo`, `pi-foo`, `foo`, with status key `foo`.
3. Match package-derived status keys by exact key or delimiter-bound namespace prefix only, e.g. package `@scope/pi-foo` may match status keys `foo`, `foo:server`, or `foo/server`, but not `foobar`.
4. When rendering a status key, resolve icons in this order:
   - exact configured status key, preserving current behavior and empty-string suppression;
   - configured installed package id/alias associated with that status key;
   - leading emoji from the status text;
   - built-in default icon;
   - generic `🔌` fallback.

## Non-Goals

- Do not require third-party extensions to change their `ctx.ui.setStatus()` keys.
- Do not add dependencies between `pi-statusline` and status-producing extensions.
- Do not redesign the status settings file beyond `extensionStatusIcons`.
- Do not add a UI editor for icon settings in this issue.

## Assumptions

- “Extension id” means the installed package id/name from Pi package settings, such as `@scope/pi-foo` or `npm:@scope/pi-foo@1.2.3`, not a new runtime id API exposed by Pi.
- Third-party packages commonly emit a status key derived from their package basename, usually by dropping a leading `pi-` prefix.

## Plan

- [x] Add failing tests in `extensions/pi-statusline/test/statusline.test.ts` for third-party icon configuration by full package id, unscoped package name, `pi-`-stripped status key, and delimiter-bound namespaced status keys like `foo:server` and `foo/server`; verify the new tests fail with `npm test -- pi-statusline` or `npm test` before implementation.
- [x] Extract installed-extension package discovery from duplicate detection in `extensions/pi-statusline/src/statusline.ts` into a reusable helper that returns package names from user and project settings; verify existing duplicate-extension tests still pass with `npm test -- pi-statusline` or `npm test`.
- [x] Add a pure alias helper that maps package names to status keys and icon lookup aliases, including scoped npm packages, unscoped packages, local package names, names without a `pi-` prefix, and delimiter-bound namespace matches; verify with targeted unit tests for `@vendor/pi-foo`, `pi-foo`, `@vendor/foo`, versioned `npm:` specs, `foo:server`, `foo/server`, and non-match `foobar`.
- [x] Thread the alias map through runtime/config rendering so `formatExtensionStatus()` can resolve exact status-key overrides before installed package-id aliases; verify with tests that exact key config wins over package-id config and `""` still suppresses icons.
- [x] Preserve fallback behavior for statuses with no matching installed package or configured icon; verify existing unknown-status and leading-emoji tests remain unchanged.
- [x] Update `extensions/pi-statusline/README.md` to document configuring icons by status key or installed extension id, including one third-party example; verify examples match the implemented alias precedence by inspection.
- [x] Run `npm run check` from the repository root and fix formatting, type, boundary, or test failures.

## Risks

- Status keys are extension-chosen strings, so package-name aliasing is heuristic. Keep exact status-key overrides highest priority so users can always force the intended icon.
- Multiple installed packages can derive the same status key. Do not apply package-id alias matches for ambiguous derived keys; document that exact status-key config disambiguates collisions.
- Reading settings for aliases must not add heavy work to every render. Compute aliases during footer installation/session setup, like duplicate-extension detection.

## Completion Checklist

- [x] `extensionStatusIcons` supports exact status-key overrides, installed package id/alias overrides, and delimiter-bound namespaced status keys, verified by unit tests in `extensions/pi-statusline/test/statusline.test.ts`.
- [x] Exact status-key overrides, including empty-string suppression, take precedence over package-id aliases, verified by a regression test.
- [x] Existing leading emoji, built-in default icon, and generic fallback behavior remains unchanged, verified by existing and updated tests.
- [x] README documents third-party extension icon configuration, verified by review of `extensions/pi-statusline/README.md`.
- [x] Repository verification passes with `npm run check`.
