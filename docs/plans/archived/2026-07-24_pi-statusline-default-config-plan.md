# pi-statusline default config and custom palette plan

## Goal

Keep the first-run `pi-statusline.json` discoverable without materializing an inactive custom palette, and make the `custom` palette selection produce an immediately usable editable palette without adding a cumbersome per-color menu.

## Context

- Runtime normalization already accepts partial settings and supplies complete built-in defaults.
- The current first-run document expands every advanced field, including a palette ignored while a named preset is active.
- `/statusline` already provides a preset picker with live preview and a JSON editor suitable for free-form color values.

## Non-Goals

- Add a terminal color picker or 24-field foreground/background settings screen.
- Rewrite existing user settings or remove existing custom palettes.
- Change the rendering semantics of manually authored partial custom palettes.

## Plan

- [x] Add focused settings and command tests specifying a first-run document without an inactive palette, custom-palette seeding from the active named preset, preservation of an existing custom palette, and visible custom-editing guidance; focused assertions failed before implementation.
- [x] Update `extensions/pi-statusline/src/settings.ts` and preset utilities so built-in runtime defaults remain complete while the created document omits the inactive palette and selecting an unconfigured `custom` palette materializes the active named preset's per-segment colors; all 69 pi-statusline tests pass.
- [x] Update `extensions/pi-statusline/src/commands.ts` so the custom picker and main menu expose the existing JSON editing path without a blocking warning or a separate per-color menu; command tests pass, including guidance and preservation cases.
- [x] Update `extensions/pi-statusline/README.md` to document the editable initial document, active built-in defaults, custom-palette materialization, and editing workflow; reviewed against the tested field set, seeding behavior, menu labels, and notifications.
- [x] Run `npm run check`, inspect the final diff for bounded compatibility-safe changes, and archive this completed plan under `docs/plans/archived/`; the full 1,172-test repository gate passed and the diff changes only pi-statusline plus this plan.

## Completion Checklist

- [x] New installations expose `palettePreset`, `density`, `separator`, `segments`, `segmentText`, and `extensionStatusIcons` while omitting only the inactive custom `palette`; normalized runtime settings retain all existing defaults.
- [x] Selecting `custom` with no palette writes a complete palette derived from the currently active named preset; selecting it with an existing palette preserves that palette and unknown fields.
- [x] The picker and main menu clearly identify where custom colors are edited, with no forced editor or per-color menu.
- [x] Existing malformed-file, cancellation, atomic-save, legacy, and named-preset behavior remains covered and passing.
- [x] `npm run check` passes and the plan is archived.
