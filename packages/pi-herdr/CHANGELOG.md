# @narumitw/pi-herdr

## 0.2.0

### Minor Changes

- 4b143f4: Add a /herdr menu with a persistent agent-widget toggle, status, and help. Keep the widget enabled by default and lifecycle reporting independent of visibility.

## 0.1.1

### Patch Changes

- f92ea02: Replace the duplicated Herdr operating guide with a thin bootstrap that loads version-matched instructions from `herdr --skill` once per retained context.

## 0.1.0

### Minor Changes

- 3005cd2: Publish bounded Pi model, provider, Thinking level, session, and context-usage metadata to Herdr.
  
  Synchronize the bundled Herdr blocked-agent safety guidance and align widget states with semantic Pi theme roles.
- ee0b28a: Bundle Herdr's Pi agent-state integration with the `herdr` operating skill in one installable package.
  
  Report interactive Pi session and lifecycle state to Herdr with bounded local socket retries and shutdown cancellation.
  
  Show recognized sibling agents from the current Herdr workspace in a terminal-safe, event-driven widget above Pi's editor, with distinct state, renamed agent, pane, and workspace identities.

### Patch Changes

- 071454c: Align the sibling-agent widget's state icons with Herdr's distinct static status symbols.
