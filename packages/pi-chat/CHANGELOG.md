# @narumitw/pi-chat

## 0.1.7

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.1.6

### Patch Changes

- 5333554: Promote the extensions to the stable lifecycle and remove their experimental warnings.
  
  Pi Fleet no longer asks for separate experimental consent before its existing launch and join confirmations.

## 0.1.5

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.1.4

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.1.3

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.1.2

### Patch Changes

- 11bdf1e: Update runtime dependencies for chat networking, Starship TOML parsing, and TUI syntax highlighting.
- Updated dependencies [11bdf1e]
  - @narumitw/pi-tui-kit@0.54.1

## 0.1.1

### Patch Changes

- fa9c938: Reduce idle startup imports by loading Goal presentation, Chat networking and UI, and Sync operation-specific modules only when their routes require them.

## 0.1.0

### Minor Changes

- cba2be9: Replace full-mesh chat with signed, duplicate-suppressing gossip and add an estimated P2P public-room browser.
- 5554261: Add the experimental Pi Chat extension for ephemeral DHT-discovered peer-to-peer developer chat.

### Patch Changes

- Updated dependencies [2d79365]
  - @narumitw/pi-tui-kit@0.50.0
