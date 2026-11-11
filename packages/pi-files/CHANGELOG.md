# @narumitw/pi-files

## 0.2.1

### Patch Changes

- cf7b63d: Put editor widget names and short current count/state summaries in their divider lines. Remove duplicate body titles while retaining safety text, detail rows, privacy modes, and standalone RPC/tool output. In fullscreen Pi, click anywhere in a widget to collapse it to one named line, then click that line to restore the latest content. Preserve independent, session-local disclosure through updates without taking editor focus, changing domain data, or stopping background work. Existing owner controls provide keyboard restoration; regular-mode mouse input remains terminal-owned.
  
  The Kit minor release supplies the named widget state and publisher disclosure APIs. Changesets raises all adopting consumers' Kit dependency floors in the same Version PR. Publish and verify the exact Kit artifact before its consumers.
- Updated dependencies [cf7b63d]
  - @narumitw/pi-tui-kit@0.70.0

## 0.2.0

### Minor Changes

- 1adf006: Introduce Pi Files with one `/files` manager for file context and independent native edit restrictions. Preserve dedicated compatibility commands, both user settings stores, immutable snapshots, branch-owned scope entries, and historical notice identities. Document migration from the archived predecessors without co-loading guards.

## 0.1.0

### Minor Changes

- Merge File Context and Edit Scope into one independently installable extension with a `/files` manager, common settings, and combined status. Keep context selection and edit permission independent.
- Preserve the dedicated compatibility commands, context workflows, native-tool guard, settings filenames, branch-owned scope entries, original entry IDs, and historical model notices.
- Archive both predecessor packages in the repository and document migration without co-loading. This release intent does not authorize publication or npm deprecation notices.
