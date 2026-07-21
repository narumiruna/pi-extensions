## Goal

Prototype an extension-owned mouse-drag text selector for `/btw`: after invoking `/btw`
without a question, the user can choose one current-branch user/assistant text message, drag
across its rendered text, review the highlighted range, and ask a side-thread question about
the exact selected text. Keyboard selection remains available when mouse reporting is
unsupported.

Success means selection happens inside a pi-btw-controlled full-screen TUI, not through the
terminal emulator's native highlight or clipboard, and every exit/error path restores normal
terminal mouse behavior.

## Context

Pi 0.80.10 does not expose a high-level mouse-selection API or the terminal emulator's native
selection. Its public `TUI` surface does expose `terminal.write()`, custom components, overlays,
and raw `handleInput()` data; pi-tui's stdin buffer already preserves complete SGR mouse
sequences. The prototype can therefore implement xterm mouse reporting inside its own UI,
but it must own coordinate mapping, highlighting, compatibility detection, and cleanup.

## Architecture

- Keep follow-up threads independent from selection. The selector produces only
  `{ selectedText, question }`, then calls the existing ephemeral side-thread runner.
- Open a pi-btw-controlled full-screen overlay so terminal mouse coordinates have a known
  origin. Do not attempt to map clicks onto Pi's existing main transcript.
- Enable button-motion and SGR coordinates while the overlay is active with
  `CSI ? 1002 h` and `CSI ? 1006 h`; disable both modes with the matching `l` sequences.
- Parse SGR events shaped like `CSI < button;x;y M/m` into press, drag, and release events.
  Ignore malformed, out-of-bounds, wheel, and unsupported-button events.
- Build a render map from every visible terminal cell to an original text offset. Base it on
  grapheme clusters and visible cell widths so wrapped lines, CJK, emoji, tabs, blank lines,
  and combining marks select the intended raw text rather than the rendered ANSI output.
- Restrict the first version to one user/assistant text message and one contiguous character
  range. Preserve Markdown/code-fence characters in the selected payload while escaping
  terminal controls in the display layer.
- Make mouse-mode ownership explicit and idempotent. A single cleanup function must run for
  confirm, `Esc`, `Ctrl+C`, UI disposal, thrown errors, session replacement, and partial
  initialization; it must never disable a mode the component did not enable.
- Retain keyboard fallback and expose a visible mouse-support warning rather than silently
  trapping users in a mouse-only screen.

## Non-Goals

- Reading the terminal emulator's native highlight or primary selection.
- Reading or writing the system clipboard.
- Dragging directly over Pi's existing main transcript.
- Cross-message selection, rectangular/column selection, or selecting thinking/tool/image
  blocks in the first version.
- Persisting selected text or side-thread messages in the main session.

## Unknowns

- Whether all supported Pi terminals and tmux configurations forward `1002`/`1006` events;
  resolve with a bounded compatibility spike and document the tested matrix.
- Whether a full-screen overlay is consistently positioned at terminal row/column 1 across
  resize and alternate render configurations; prove this with a runtime spike before building
  character mapping on that assumption.
- Pi's custom-component API has no explicit disposal hook. Determine which command/UI
  lifecycle boundaries can guarantee mouse-mode cleanup and add a process/session fallback if
  normal component completion is insufficient.

## Plan

- [ ] Add failing parser tests for SGR press, drag, release, modifiers, malformed sequences,
  wheel events, and coordinate bounds; verify the red phase with root `npm test`.
- [ ] Implement a pure SGR mouse parser and drag state machine with no terminal writes; verify
  deterministic start/update/reverse/release/cancel behavior through table-driven tests.
- [ ] Run a minimal full-screen overlay spike that enables `1002`/`1006`, displays received
  coordinates, survives resize, and always restores both modes; record tested terminals and
  the overlay-origin result in this plan before continuing.
- [ ] Add failing render-map tests for ASCII, wrapping, blank lines, tabs, Markdown fences,
  CJK, emoji, combining marks, and wide-grapheme boundary clicks; implement bidirectional
  cell-to-source-offset mapping until those tests pass.
- [ ] Build the mouse selection component with live highlighting, auto-scroll near viewport
  edges, character/byte count, a 20,000-character limit, `Enter` confirm, `Esc` back, and
  `Ctrl+C` cancel; verify width/height, resize, reverse drags, empty ranges, and terminal-control
  escaping with a component harness.
- [ ] Add keyboard fallback to the same character-range model and show a visible compatibility
  hint (`drag to select`, keyboard keys, and `Shift` for terminal-native selection where the
  emulator supports that override); verify that every flow is operable without mouse events.
- [ ] Integrate no-argument `/btw` as message picker → mouse/keyboard range selector → question
  editor → existing side-thread runner, while preserving `/btw <question>`; verify navigation,
  cancellation, selected-text prompt isolation, and no main-session mutation with injected
  state-machine tests.
- [ ] Centralize idempotent mouse-mode cleanup and test confirm, cancel, parser failure,
  rendering failure, provider cancellation, session replacement, and repeated cleanup; use a
  fake terminal write log to prove each enabled mode receives exactly one matching disable.
- [ ] Update `extensions/pi-btw/README.md` with supported interaction, terminal/tmux caveats,
  keyboard fallback, native-highlight limitation, and recovery instructions; verify wording
  against the compatibility spike evidence.
- [ ] Run `npm run check` and `just pack-btw`, then perform a maintainer-approved interactive
  smoke test in each available target terminal before enabling the feature by default.

## Risks

- Failing to disable mouse reporting can make normal terminal selection appear broken. Cleanup
  correctness is a release blocker, not a best-effort enhancement.
- Mouse coordinates are terminal cells, while source text uses Unicode offsets; incorrect
  grapheme/wide-cell mapping can select different text from what is highlighted.
- Full-screen overlays and raw terminal modes rely on lower-level TUI behavior that may change
  between Pi versions. Keep protocol and mapping code isolated and version-tested.
- Enabling mouse reporting usually captures ordinary drag gestures. Users may need `Shift` to
  invoke the terminal emulator's native selection while the selector is open.

## Rollback / Recovery

Keep the prototype behind an explicit experimental setting until the terminal compatibility
and cleanup checks pass. If mouse handling fails, disable mouse reporting immediately and
fall back to keyboard selection. If cleanup cannot be guaranteed through Pi's lifecycle,
do not ship the mouse mode.

## Completion Checklist

- [ ] Mouse press/drag/release parsing is verified by parser tests containing valid, malformed,
  modifier, wheel, and out-of-range sequences.
- [ ] Highlighted terminal cells map to the exact raw selected text for wrapping and Unicode,
  verified by render-map fixtures.
- [ ] Every enabled mouse mode is restored on all completion, cancellation, exception, resize,
  and session lifecycle paths, verified by fake-terminal write assertions and interactive
  smoke evidence.
- [ ] The selector works without mouse input through keyboard fallback, verified by component
  and command state-machine tests.
- [ ] Direct `/btw <question>` and ephemeral follow-up behavior remain unchanged, verified by
  `npm run check`.
- [ ] No selected text or side-thread turn is added to the main session, verified by captured
  provider requests and session-mutation assertions.
- [ ] Package contents include only intended runtime modules and documentation, verified by
  `just pack-btw`.
- [ ] User accepts the tested mouse UX and documented terminal limitations after interactive
  trial; record the accepted terminals before archiving this plan.
