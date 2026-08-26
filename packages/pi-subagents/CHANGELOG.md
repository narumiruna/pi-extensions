# @narumitw/pi-subagents

## 2.1.2

### Patch Changes

- 6dd7b9e: Persist restored todo, subagent guidance, and required-completion context boundaries as validated branch-local session metadata so reloads and tree navigation preserve stable model-visible prefixes.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 2.1.1

### Patch Changes

- 3c19622: Restore compacted todo and required-subagent state at deterministic summary boundaries, retain each restored message for its summary epoch as later tail evidence supersedes it, and append restored required-run cancellations after stale retained handoffs while keeping request prefixes stable.
  
  Publish mutable subagent catalog and policy guidance through append-only session contracts instead of re-registering provider-visible tools.

## 2.1.0

### Minor Changes

- 4ae6dcf: Add exact required-run tracking for detached completion dependencies, preserve usable budget-stopped evidence as typed partial outcomes, and provide a paired async-versus-sync quality benchmark.
- a385642: Deprecate the blocking `subagent` tool for new work while preserving its compatibility schema and execution behavior.
- 430faae: Add opt-in, local-only, content-free usage recording with a 30-day retention window and status reporting.
- a53e6eb: Add `subagent_await` for intentionally joining one retained subagent turn with a bounded wait that never interrupts the child.

### Patch Changes

- baaeed7: Replace the `/subagents` menu with a novice-friendly five-action manager, task-oriented settings groups, concise help, and clearly labeled diagnostics.
- 29095f1: Guide ordinary detached spawns away from unsupported enforced guarantees, preserve practical evidence budgets and concise interim progress, report safe contract-repair recovery, and suppress same-session completion re-enqueue after acknowledgement.
- b536cac: Steer detached completions into active parent work and strengthen final-synthesis guidance without adding a blocking barrier.
- 0b73f9d: Present async-only delegation as a neutral optional workflow instead of the recommended choice.
- afcb2f5: Keep `subagent` and `subagent_spawn` tool schemas compatible with llama.cpp by omitting large nested string repetitions while retaining runtime input bounds.

## 2.0.6

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 2.0.5

### Patch Changes

- e7c41f1: Include the generated child peer bridge in the published runtime so retained subprocess and RPC agents can launch from npm installs.

## 2.0.4

### Patch Changes

- 0ffd80d: Preserve accurate cumulative RPC usage telemetry during streaming, interruption, and timeout finalization.
- Updated dependencies [f47364f]
  - @narumitw/pi-tui-kit@0.56.1

## 2.0.3

### Patch Changes

- 806eada: Reduce extension startup time by letting generated TypeScript chunks reference their emitted `.ts` files directly.

## 2.0.2

### Patch Changes

- 1fa501f: Reduce idle startup work by separating Pi registration and read-only settings modules from backward-compatible utility exports and settings mutations.
- 9224800: Load the extension from a generated split TypeScript runtime to reduce Jiti startup work while preserving existing first-use boundaries.

## 2.0.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 2.0.0

### Major Changes

- 00641d5: Remove the built-in `planner` subagent and the `subagent_auto` autonomous workflow planning tool.
  Also remove `bash` from the built-in `explorer` default tools so automatic transport keeps a default read-only in-process route.
  Use main-agent-authored `subagent` workflow calls when explicit task graphs are needed.
- 9c78581: Remove the built-in `reviewer` subagent so the built-in catalog exposes only `explorer` and `worker`.
  Review workflows can still use custom user or project agents with review capabilities.
- 9308460: Remove the built-in `general` and `general-purpose` worker aliases so the built-in implementation agent catalog exposes only `worker`.
  Remove Fast/Balanced/Deep execution profile presets so thinking defaults are selected by task calls or explicit per-agent settings.
  Default the built-in `explorer` agent to `low` thinking while `worker` inherits unless configured.
- 3cc246d: Rename the built-in `scout` subagent to `explorer` to align the read-only codebase exploration role with Codex.
  Existing `agents.scout` settings apply to `explorer` when they are unambiguous.

### Minor Changes

- 8912e81: Add canonical retained-agent task paths, authenticated child peer messaging, and direct-parent completion delivery while preserving opaque agent IDs.
- 613b83a: Allow detached write-capable subagents to run concurrently in the shared workspace by default.
  Keep disposable worktree isolation available and accept `allowConcurrentWrites` as a deprecated compatibility field.
- 6d8941e: Render detached completion messages as compact TUI summaries that expand to their full safe payload with Pi's tool-output toggle.
- fcb1b92: Give structured-v2 subagents a complete copyable result shape and prevent non-waking completion steering from being inserted repeatedly during active parent turns.

### Patch Changes

- e4ceb64: Align delegation guidance around main-agent-owned critical-path work, integration, final verification, and final answers.
  Require one ordinary async worker to run beside named non-overlapping main-agent work, and remove guidance that allowed the main agent to announce one spawn and stop.
- 227ac27: Expose each agent's declared capabilities, configured tools, filesystem authority, and result formats in the initial parent-facing catalog.
  Warn before delegation that enforced path, network, and secret guarantees are unsupported.
- ea22b7d: Recommend the async-only workflow in the `/subagents` chooser and README while preserving all delegation methods as the compatibility default.
  Document exact mode-specific tool surfaces and retain explicit blocking, consultation, and split lifecycle compatibility routes.
- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 1.0.2

### Patch Changes

- df627e4: Reduce idle startup import work by lazily loading heavier subagent runtime modules.

## 1.0.1

### Patch Changes

- 5a14026: Reduce idle Pi startup imports by loading Subagents execution and selected transport implementations, plus Workflow manager and fresh-session handoff code, only when their registered routes first need them.

## 1.0.0

### Major Changes

- e4b96b3: Persist detached completion outbox records with stable completion, run, and generation identities, retry transient terminal writes before resolving, and acknowledge only IDs observed in parent context so unacknowledged results can be redelivered without rerunning child work.

  Move retained-run listing exclusively to `subagent_inspect` and remove the compatibility `list` action from `subagent_manage`.

## 0.54.0

### Minor Changes

- 1c117e4: Add an explicit verified-execution workflow contract with executor-owned deterministic checks, exact-state receipts, managed integration acceptance, and one bounded rework cycle.

## 0.53.0

### Minor Changes

- ae0677d: Add explicit bounded autonomous workflow planning with deterministic compilation, verified mutating execution, and generation-safe graph revisions.

### Patch Changes

- Updated dependencies [4a0358b]
- Updated dependencies [93b507b]
  - @narumitw/pi-tui-kit@0.53.0

## 0.52.0

### Minor Changes

- 9cb747f: Gate verification-required explicit workflow results on one distinct fresh-context verifier, an unchanged bounded Git-visible tree identity, and an executor-owned accept, rework, or reject receipt instead of trusting implementation-worker self-checks.

## 0.51.0

### Minor Changes

- 4d50d23: Add capability manifests, executor-owned execution plans, structured v2 outcomes, explicit dependency workflows with artifact provenance and adaptive scheduling, bounded retry and hedging policies, semantic continuation snapshots, and actionable retained lifecycle states.
- 0045392: Add a first-class blocking panel mode with independent reviewer contracts, bounded evidence artifacts, reserved synthesis and cleanup budgets, objection-preserving synthesis, failure-specific recovery, WorkItem inspection metadata, and disposable worktree isolation for write-capable reviewers.
- af98607: Add persistent RPC and automatic detached transports, execution profiles and per-agent defaults, main-agent-selected per-turn and whole-workflow execution budgets, deterministic timeout checkpoints with abort-then-summary recovery, bounded runtime telemetry, spawn idempotency, context preview, and opt-in structured completion metadata.

## 0.50.0

### Minor Changes

- c47a4cc: Add interactive detached-agent capacity, concurrency, depth, child, and persistence limit settings.
- d1e4ca7: Add a user-configurable maximum for blocking parallel subagent workers.
