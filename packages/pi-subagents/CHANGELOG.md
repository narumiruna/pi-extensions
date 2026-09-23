# @narumitw/pi-subagents

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
