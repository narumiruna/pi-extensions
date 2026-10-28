# @narumitw/pi-subagents

## 3.4.0

### Minor Changes

- a21d39b: Add opt-in editor status presentation helpers for stable snapshot publication, session-local view controls, and bounded whole-snapshot collections. Keep the existing EditorStatusWidget API unchanged.
  
  Retain visible Progress, Subagents, and Herdr widgets during updates. Add bounded summaries, manual view and item controls, and explicit one-shot compaction policies to Progress and Subagents without changing task state or persistent defaults. Preserve Progress completion retention and keep Herdr observation policies local. Keep tree navigation and manual context compaction separate from response-cycle tracking.
- 106ef89: Add optional `provider` and `model` parameters to `subagent_spawn`. Each omitted value inherits independently from the effective parent model at spawn time. Explicit IDs use exact matching without fallback, including listed case-distinct and provider-prefixed IDs. Only the child checks model registration and current availability. The requested pair bypasses CLI pattern matching and is bound exactly before the child receives its task. A missing or unavailable model fails the job after `subagent_spawn` returns its `jobId`.
  
  Unlisted custom model IDs previously accepted through Pi's CLI now fail, including inherited IDs. Register each exact model in Pi's `models.json` or attach a trusted extension that registers it in the child. Parent-only providers, runtime API keys, and virtual routing state are not forwarded. Reload or replace the session after upgrading to load the new tool schema.
  
  Reject oversized provider and model IDs before character validation. Schema bounds and runtime byte checks use the existing shared 16 KiB child-bootstrap limit without adding a shorter naming limit.

### Patch Changes

- 1e33872: Use task-first widget rows and hide job IDs and tool names by default while preserving saved preferences. Show thinking only when it differs from the main agent's level captured at spawn. Omit redundant running labels and unset timeout text; show elapsed time for running jobs and queued status for waiting jobs.
- 99b7c92: Show provider and model IDs in expanded widget rows only when they differ from the main agent's effective values captured at spawn, matching thinking-level display. Keep inherited and explicit-equal values hidden, and preserve each job's comparison after parent model changes.
- Updated dependencies [a21d39b]
- Updated dependencies [f68aa54]
- Updated dependencies [b062d21]
  - @narumitw/pi-tui-kit@0.68.0

## 3.3.3

### Patch Changes

- Updated dependencies [57eeae7]
  - @narumitw/pi-tui-kit@0.67.0

## 3.3.2

### Patch Changes

- 168248c: Reuse published TUI Kit frame metadata, masked input, configured-key syntax, and interaction ownership while retaining extension-owned settings and cancellation policy. Keep malformed Ticker key strings from suppressing valid reorder shortcuts, and drain Usage settings saves after cancellation.

## 3.3.1

### Patch Changes

- 9edf94b: Show each active job’s spawn-time thinking level in the above-editor widget.

## 3.3.0

### Minor Changes

- 53730f9: Add the `/subagents` job manager and `/subagents settings` route. Support confirmed active-job cancellation and persistent widget, job ID, tool, and timing display preferences without changing model tools or job execution.

### Patch Changes

- 9f80b89: Reuse published Kit interaction ownership for native Progress and Subagents settings while preserving ordered saves, rollback, and durable-save recovery after the screen closes.
  
  Share passive widget framing in Subagents, Tool, Plan Mode, and Cache Hit Monitor. Keep domain rendering and lifecycle ownership local, bound narrow and invalid widths, and retain lazy loading of Kit menus and other interactive APIs.
- 3dd82ec: Add transcript expansion and collapse for child requests and responses using Pi's configured tool-output expansion key.
- Updated dependencies [077137a]
- Updated dependencies [9f80b89]
- Updated dependencies [efc474c]
  - @narumitw/pi-tui-kit@0.66.0

## 3.2.1

### Patch Changes

- dfc020b: Show a sanitized, shortened preview of each active subagent's existing task in the TUI widget without changing the spawn schema or inspection metadata.

## 3.2.0

### Minor Changes

- ca27497: Allow subagent jobs to select Pi's native codemode tool explicitly, with startup readiness verification and unchanged default tools.

## 3.1.1

### Patch Changes

- 68c4b95: Update runtime dependencies and preserve Pi tool-context types through the LSP session lifecycle guard for compatibility with current Pi releases.

## 3.1.0

### Minor Changes

- aec9773: Allow each subagent job to attach validated local skills and trusted extensions with an attested initial tool allowlist.

## 3.0.2

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 3.0.1

### Patch Changes

- 99f0bcc: Start subagent jobs from Pi's bundled executable when the package manifest points to a source-only CLI path.

## 3.0.0

### Major Changes

- 99c304e: Replace the legacy orchestration runtime with subagent jobs and authenticated main-agent messaging.
  
  Remove `/subagents`, extension settings, persisted and retained agents, the previous blocking orchestration interfaces, custom agent catalogs, advanced orchestration, alternate transports, trust-aware cwd policy, and extension-owned worktrees.
  
  Use `subagent_spawn`, `subagent_inspect`, `subagent_cancel`, `subagent_wait`, and the context-specific main-agent and child `subagent_send` contracts directly or through a user-designed skill after upgrading, and start a fresh Pi session so stored calls do not request removed tool names or the legacy `subagent_send` schema.
  
  Main agents can send requests to queued or running jobs, and children can send requests to main, while either side answers with the same request ID through `subagent_send`.
  
  A queued main-agent request interrupts active child response waits without consuming the original child requests, so RPC steering can proceed and those waits can be retried.
  
  The package no longer registers or publishes a delegation skill, while the repository keeps `using-pi-subagents` as an example for designing one.
  
  Completion messages follow Pi's global tool-output expansion state and configured `app.tools.expand` binding.

### Patch Changes

- e55825e: Update the repository-only example skill to require independent work or a concrete context-isolation benefit before delegating to a subagent.
