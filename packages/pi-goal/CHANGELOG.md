# @narumitw/pi-goal

## 0.54.0

### Minor Changes

- b59cdbc: Remove the `toolVisibility` setting and keep Goal helper schemas stable from startup.
  Retired settings keys are ignored and preserved, while restrictive external tool policies now reject or pause Goal work without being widened.

## 0.53.3

### Patch Changes

- 21f96d0: Keep Goals recoverable in deadline-free waiting after transient provider retries are exhausted so a later follow-up can continue, complete, or wait again with the same Goal ID.
- 22ae047: Preserve retained conversation cache prefixes with append-only superseding Goal contracts, atomic handoff-boundary persistence, and current-state restoration after lifecycle transitions and compaction.

## 0.53.2

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.53.1

### Patch Changes

- 4098679: Keep token-budget accounting out of leading system instructions and preserve the post-activation provider request prefix across Goal continuation and wait resume.

## 0.53.0

### Minor Changes

- b23a1bc: Coordinate automatically executable Goals through Workflow Mutex Protocol v1 and stop Goal-owned work immediately at terminal limits.

## 0.52.3

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.52.2

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.52.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.52.0

### Minor Changes

- 5269d4b: Remove the experimental ordered-goal queue and guide affected users to reprioritize with `/goal edit`.

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.51.0

### Minor Changes

- ef4680b: Start `goal_complete`, `goal_blocked`, and `goal_wait` inactive by default until the first Goal activation or unfinished-goal restore.

## 0.50.0

### Minor Changes

- db4b576: Add `goal_wait` so active Goals can wait quietly for external messages or an optional bounded deadline without creating automatic continuation loops.

### Patch Changes

- d105b85: Clamp sub-ten-second `goal_wait` deadlines and report their effective delay to prevent rapid automatic wake loops.

## 0.49.7

### Patch Changes

- fa9c938: Reduce idle startup imports by loading Goal presentation, Chat networking and UI, and Sync operation-specific modules only when their routes require them.

## 0.49.6

### Patch Changes

- 6f98395: Sanitize terminal-rendered Goal text, bound terminal-tool inputs and outputs, report malformed commands in headless modes, and keep runtime smoke coverage on public Pi APIs.
