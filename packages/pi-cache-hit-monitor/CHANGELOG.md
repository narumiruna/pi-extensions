# @narumitw/pi-cache-hit-monitor

## 0.1.4

### Patch Changes

- cf7b63d: Put editor widget names and short current count/state summaries in their divider lines. Remove duplicate body titles while retaining safety text, detail rows, privacy modes, and standalone RPC/tool output. In fullscreen Pi, click anywhere in a widget to collapse it to one named line, then click that line to restore the latest content. Preserve independent, session-local disclosure through updates without taking editor focus, changing domain data, or stopping background work. Existing owner controls provide keyboard restoration; regular-mode mouse input remains terminal-owned.
  
  The Kit minor release supplies the named widget state and publisher disclosure APIs. Changesets raises all adopting consumers' Kit dependency floors in the same Version PR. Publish and verify the exact Kit artifact before its consumers.
- Updated dependencies [cf7b63d]
  - @narumitw/pi-tui-kit@0.70.0

## 0.1.3

### Patch Changes

- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- Updated dependencies [54f2700]
- Updated dependencies [6c76ef1]
  - @narumitw/pi-tui-kit@0.69.0

## 0.1.2

### Patch Changes

- 9f80b89: Reuse published Kit interaction ownership for native Progress and Subagents settings while preserving ordered saves, rollback, and durable-save recovery after the screen closes.
  
  Share passive widget framing in Subagents, Tool, Plan Mode, and Cache Hit Monitor. Keep domain rendering and lifecycle ownership local, bound narrow and invalid widths, and retain lazy loading of Kit menus and other interactive APIs.
- Updated dependencies [077137a]
- Updated dependencies [9f80b89]
- Updated dependencies [efc474c]
  - @narumitw/pi-tui-kit@0.66.0

## 0.1.1

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.1.0

### Minor Changes

- f316335: Add the Cache Hit Monitor extension for live prompt-cache reuse, token, and estimated cost diagnostics above Pi's editor.
