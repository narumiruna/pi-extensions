## Goal

Let `pi-statusline` switch statusline presets through an environment variable, initially
supporting `classic` and `tokyo-night`, while preserving the current information content,
emoji, second-line extension statuses, and safe truncation behavior.

## Context

`extensions/pi-statusline/src/statusline.ts` has already changed to a Tokyo Night colored,
Starship-inspired powerline renderer. It was inspired by the Starship Tokyo Night preset
(https://starship.rs/presets/tokyo-night), whose format uses a `░▒▓` prefix, ``
powerline joins, and the `#a3aed2`, `#769ff0`, `#394260`, `#212736`, and `#1d2230` color
scale. To avoid breaking users who prefer the original style, the next step should restore
the classic renderer and add a preset selector instead of splitting it into another
extension.

## Non-Goals

- Do not parse Starship TOML.
- Do not add YAML/JSON config.
- Do not add arbitrary palette/layout customization.
- Do not add runtime dependencies.

## Assumptions

- `PI_STATUSLINE_PRESET=tokyo-night` enables the new powerline appearance.
- `PI_STATUSLINE_PRESET=classic` enables the original appearance.
- When unset or invalid, use `tokyo-night` as the current new default for now; if avoiding a
  breaking change is required, switch this to `classic` before implementation.

## Plan

- [x] Add `StatuslinePresetName = "classic" | "tokyo-night"` and
  `readStatuslinePreset()` to `extensions/pi-statusline/src/statusline.ts`, reading the
  preset from `process.env.PI_STATUSLINE_PRESET`; verified with
  `rg "PI_STATUSLINE_PRESET|StatuslinePresetName" extensions/pi-statusline/src` and
  `npm run check --workspace @narumitw/pi-statusline`.
- [x] Keep the current Tokyo Night powerline renderer as `renderTokyoNightStatusline()` and
  dispatch from `renderStatusline()` based on the config preset; verified by
  `extensions/pi-statusline/presets/tokyo-night.ts` and the `renderStatusline()` switch,
  with the `tokyo-night` path preserving the `░▒▓` / `` truecolor blocks.
- [x] Restore the logic needed by the classic renderer from git diff or a previous version:
  `RIGHT_SEGMENTS`, palette/density/separator, `joinSegments()`, `styleSegment()`,
  `thinkingColor()`, `contextColor()`, and labeled segment color; verified by
  `extensions/pi-statusline/presets/classic.ts`, `pickColor()`, `thinkingColor()`,
  `contextColor()`, and typecheck.
- [x] Split each preset into separate `.ts` files as requested by the user, including
  `extensions/pi-statusline/presets/classic.ts`,
  `extensions/pi-statusline/presets/tokyo-night.ts`,
  `extensions/pi-statusline/presets/ansi.ts`, and
  `extensions/pi-statusline/presets/types.ts`; verified with
  `find extensions/pi-statusline -path '*presets/*.ts' -type f` and typecheck.
- [x] Adjust the shared segment model so the `color` required by classic and the `block`
  required by tokyo-night do not contaminate each other; verified because `RenderSegment`
  carries both `color` and `block`, each preset renderer consumes only the fields it needs,
  and `npm run check --workspace @narumitw/pi-statusline` passes.
- [x] Make the second-line extension statuses use a preset-specific separator: classic uses
  Pi theme dim `•`, while tokyo-night uses truecolor powerline-compatible ``; verified by
  `extensionStatusSeparator()`, `classicExtensionSeparator()`, `tokyoNightExtensionSeparator()`,
  and typecheck.
- [x] Update `extensions/pi-statusline/README.md` to document
  `PI_STATUSLINE_PRESET=classic|tokyo-night`, the default value, invalid-value fallback,
  emoji preservation, and the Tokyo Night inspiration link; verified with
  `rg "PI_STATUSLINE_PRESET|https://starship.rs/presets/tokyo-night" extensions/pi-statusline/README.md`.
- [x] Run `npm run check --workspace @narumitw/pi-statusline`, `npm run check`, and
  `just pack-statusline`; all three commands succeeded, and the pack dry run listed the
  expected package files: `LICENSE`, `README.md`, `package.json`, `src/statusline.ts`, and
  `presets/*.ts`.

## Risks

- Maintaining both classic and tokyo-night renderers adds a small amount of duplicated
  logic; this is contained with shared data collection and small renderer functions.
- ANSI truecolor/bold reset may affect truncation or background continuation; keep
  `truncateToWidth(..., "")`, and the Tokyo Night renderer does not manually cut ANSI
  strings by visible string length.

## Completion Checklist

- [x] `PI_STATUSLINE_PRESET` supports `classic` and `tokyo-night`, verified by the preset
  selector and dispatch logic in `extensions/pi-statusline/src/statusline.ts`.
- [x] The classic appearance works and preserves the original emoji, left/right columns,
  and separator, verified by `extensions/pi-statusline/presets/classic.ts`, the shared
  segment builder, and typecheck.
- [x] The Tokyo Night appearance works and preserves the `░▒▓` / `` blocks and emoji,
  verified by `extensions/pi-statusline/presets/tokyo-night.ts`, the shared segment
  builder, and typecheck.
- [x] The extension statuses second line still preserves emoji icons, verified because
  `formatExtensionStatus()` / `splitExtensionStatusIcon()` were not broken and
  preset-specific separators plus check passed.
- [x] The README documents environment-variable switching and the Tokyo Night preset
  inspiration source, verified by `extensions/pi-statusline/README.md` content.
- [x] Quality gates passed, verified by successful output from
  `npm run check --workspace @narumitw/pi-statusline`, `npm run check`, and
  `just pack-statusline`.
