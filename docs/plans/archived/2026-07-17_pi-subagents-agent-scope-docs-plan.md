## Goal

Resolve GitHub issue #227 by making it unambiguous where and when `agentScope` is supplied, with copyable examples for one-shot and stateful subagents, while preserving the existing project-agent trust boundary.

## Context

`agentScope` is currently a top-level tool-call parameter, not a persisted field in `~/.pi/agent/pi-subagents.json`. A blocking `subagent` call must opt in per invocation; `subagent_spawn` supplies the scope when creating the retained agent. The README says to “Set `agentScope`” without explicitly making that distinction, so users can reasonably interpret it as a configuration-file setting.

## Non-Goals

- Do not add a persistent `defaultAgentScope` setting.
- Do not change the default scope from `"user"`.
- Do not weaken project trust checks or interactive confirmation.
- Do not change agent discovery, precedence, or execution behavior.

## Plan

- [x] Update the custom-agent documentation in `extensions/pi-subagents/README.md` to state that `agentScope` is a per-tool-call parameter rather than a `pi-subagents.json` setting; verified the section names both user and project directories and explicitly distinguishes invocation settings from persisted configuration.
- [x] Add copyable JSON examples for `subagent` and `subagent_spawn` showing `agentScope: "project"`, explain when to use `"both"`, and state that a spawned stateful agent retains its selected scope for follow-ups; verified all README JSON fences parse and each example places `agentScope` at the top level of the tool arguments.
- [x] Clarify the security behavior beside the examples: project agents require a trusted project, interactive confirmation remains enabled by default, and `confirmProjectAgents: false` suppresses only the prompt rather than the trust requirement; verified the wording against `extensions/pi-subagents/src/execution.ts` and `extensions/pi-subagents/src/stateful.ts`.
- [x] Align the tool-facing parameter descriptions in `extensions/pi-subagents/src/params.ts` and `extensions/pi-subagents/src/stateful.ts` with the README by identifying `agentScope` as a per-invocation selection with a `"user"` default; verified with `rg -n "agentScope|per-invocation|per-call" extensions/pi-subagents/src extensions/pi-subagents/README.md`.
- [x] Review the final diff against issue #227 to confirm it answers “where do I configure this?” without implying a new global setting, then run the repository gate; verified with `git diff --check` and `TMPDIR="$(realpath "${TMPDIR:-/tmp}")" npm run check`.

## Risks

- Documentation could conflate Pi’s project trust requirement with the extension’s confirmation dialog. Keep them described as separate safeguards.
- An example using only `"project"` could hide user agents from discovery. Explicitly explain that `"both"` includes user and project definitions.

## Completion Checklist

- [x] The README explicitly says `agentScope` is passed in tool arguments and is not configured in `pi-subagents.json`, verified in `extensions/pi-subagents/README.md`.
- [x] One-shot and stateful examples are present and show correctly placed `agentScope` arguments, verified by manual review and parsing all 10 README JSON examples with `JSON.parse`.
- [x] Trust, confirmation, and `"project"` versus `"both"` semantics match the implementation, verified against `extensions/pi-subagents/src/execution.ts`, `extensions/pi-subagents/src/stateful.ts`, and `extensions/pi-subagents/src/agents.ts`.
- [x] Tool schema descriptions and user documentation use consistent terminology, verified with the repository search in the plan.
- [x] Formatting, type checks, boundary checks, and tests pass, verified by `TMPDIR="$(realpath "${TMPDIR:-/tmp}")" npm run check` (541 passed, 1 skipped).
