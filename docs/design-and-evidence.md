# Design and evidence

These records explain decisions, investigations, and checks at specific revisions.
Use [package documentation](packages.md) for current behavior and [authoring conventions](extension-conventions.md) for repository requirements.

Architecture decisions record their own status and scope. Research, roadmaps, and explicitly labeled proposals are not implemented guarantees.
Verification records, benchmarks, and implementation audits retain their original paths, commands, dates, and unresolved external checks.
A historical command can refer to a package or project-local extension that has since moved; use the current package README before running it.

## Architecture decisions

- [ADR: pi-sync backend contract and publication safety](adr/pi-sync-backend-contract.md)
- [ADR: pi-sync Git backend](adr/pi-sync-git-backend.md)
- [ADR: pi-sync portable included-content policy](adr/pi-sync-portable-selection-policy.md)
- [ADR: pi-sync version 3 settings and sync setup model](adr/pi-sync-v3-settings-model.md)

## Implementation audits

- [Command output limits](exec-output-audit.md)
- [ChatGPT OAuth compaction verification](implementation-notes/chatgpt-oauth-compaction-verification.md)
- [Code scanning verification](implementation-notes/code-scanning-verification.md)
- [Editor widget consolidation](implementation-notes/editor-widget-consolidation.md)
- [Extension Independence Audit](implementation-notes/extension-independence-audit.md)
- [Pi TUI Kit core-pattern audit](implementation-notes/pi-tui-kit-core-patterns-audit.md)
- [Pi TUI Kit fullscreen compatibility audit](implementation-notes/pi-tui-kit-fullscreen-audit.md)

## Verification records

- [pi-starship module capabilities verification](verification/2026-10-23_pi-starship-module-capabilities.md)
- [pi-starship menu verification](verification/2026-10-24_pi-starship-menu.md)
- [pi-starship settings side-thread verification](verification/2026-10-24_pi-starship-settings-side-thread.md)
- [Pi Subagents widget defaults verification](verification/2026-10-28_pi-subagents-widget-defaults.md)
- [Plan mode question display verification](verification/2026-11-06_pi-plan-mode-question-display.md)
- [pi-starship individual extension status verification](verification/2026-11-06_pi-starship-extension-status.md)
- [Pi patch-release compatibility verification](verification/2026-11-10_pi-151-compatibility.md)
- [Pi Goal waiting display verification](verification/2026-11-13_pi-goal-wait-display.md)

## Benchmarks

- [Package startup loading](benchmarks/2026-11-05-package-startup.md)
- [Pi Goal incremental accounting](benchmarks/pi-goal-incremental-accounting.md)

## Research

- [LLM-Agent Least Privilege and Runtime Enforcement](research/2026-08-10_llm-agent-least-privilege-and-runtime-enforcement.md)
- [Coding-Agent Subagents: Evidence Catalog](research/coding-agent-subagents-evidence-catalog.md)
- [Coding-Agent Subagents: Research Synthesis](research/coding-agent-subagents-research.md)

## Roadmaps and proposals

- [pi-starship Command Capabilities Roadmap](roadmaps/2026-08-02_pi-starship-command-capabilities-roadmap.md)
