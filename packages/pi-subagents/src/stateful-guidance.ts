export function createSpawnPromptGuidelines(blockingEnabled = true): string[] {
	return [
		"Do not use subagent_spawn for simple or critical-path work that the main agent can perform directly. The main agent retains overall planning, immediate critical-path work, integration, final verification, and the final answer.",
		"Before one ordinary subagent_spawn, identify concrete useful non-overlapping main-agent work you can start immediately and a supported completion integration path. If none exists, perform the task directly instead of calling subagent_spawn.",
		"Give subagent_spawn a concise unique taskName using lowercase letters, digits, and underscores so the retained agent has a stable canonical task path.",
		"Set subagent_spawn thinkingLevel to the lowest sufficient thinking level for the delegated task: use off or minimal for extraction, formatting, or mechanical work; low for straightforward bounded work; medium for ordinary multi-step research or implementation; high for complex debugging, design, review, or cross-file analysis; xhigh for highly ambiguous, cross-system, or high-risk analysis; and max only for the hardest tasks when quality clearly outweighs latency and cost. Omit subagent_spawn thinkingLevel only to preserve the agent or child default.",
		"Set subagent_spawn timeoutMs to the shortest realistic work deadline for the task difficulty; use idleTimeoutMs for stalled work and maxTurns or maxToolCalls to stop repeated work without progress. Scope the task to the smallest named files or questions. When setting subagent_spawn maxTurns or maxToolCalls, leave sufficient headroom for discovery, evidence reads, and final synthesis; otherwise omit them instead of guessing speculative tight values. Split oversized tasks instead of extending budgets merely to compensate for broad scope.",
		"For an ordinary subagent_spawn, omit contract; use a delegation contract only when explicit acceptance, authority, evidence, or admission semantics are required.",
		"Do not set subagent_spawn contract enforcement to enforce with requestedAuthority readPaths, writePaths, network, or secrets; those guarantees are unsupported and reject before child launch, while capabilities and tools remain enforceable.",
		"If subagent_spawn rejects an unsupported guarantee, retry once with those fields removed or enforcement set to audit only when they were advisory; when any field is a required security boundary, stop instead of weakening it.",
		"Read the current pi-subagents session-guidance message before choosing detached completion behavior. With next-turn delivery, use subagent_spawn only when the current response does not depend on its result unless useful overlap ends with an intentional subagent_await. With auto-resume delivery, final-answer-dependent detached work may continue asynchronously.",
		'Track every final-answer-dependent subagent_spawn by setting completionRequirement to "required" and retaining its returned agentId or taskPath; treat interim output as progress, and synthesize only after every corresponding completion message is visible or terminal.',
		"Keep ordinary review in the main agent with a review skill and deterministic checks; use subagent_spawn for detached review only when consequential independent verification has concrete parallel value.",
		"Use a single subagent_spawn for a bounded implementation slice with clear ownership only when it can run beside the identified main-agent work.",
		"Use a single subagent_spawn without concurrent main-agent work only for an explicit user-requested specialist model, tool profile, or isolation boundary.",
		...(blockingEnabled
			? [
					"The subagent tool is deprecated; do not select it merely because synchronous output is required. Prefer subagent_spawn with supported completion delivery, and use subagent_await only after useful overlapping main-agent work is complete and an intentional join is required.",
					"Use deprecated subagent instead of subagent_spawn only for an existing caller or an explicit user request whose blocking chain, fan-in, panel, or workflow semantics do not yet have a detached replacement; queued steering cannot be processed until it returns.",
				]
			: []),
		"Add another subagent_spawn only for truly independent work with safe workspace concurrency and disjoint write ownership; shared workspaces permit concurrent writes by default, so use workspaceMode worktree when repository isolation is required. The main agent still owns integration.",
		"After subagent_spawn returns, immediately continue the identified local task; do not merely announce the spawn, wait, poll, or end the response while useful local work remains.",
		"When completionRequirement required subagent_spawn work remains active after local work is exhausted, emit at most one brief progress sentence and end the turn; do not repeat waiting updates or use the requested final format, verdict, or conclusion until every required completion is visible or terminal. Current Pi versions do not enforce a hard pre-display barrier.",
		"Do not duplicate assigned work from subagent_spawn while its retained agent is running; use a bounded parent fallback only after its completion reports failure or insufficient evidence.",
		'Consume and synthesize available subagent_spawn completion messages; use subagent_manage with action "interrupt" or "close" for agents that are no longer needed.',
		'Completion from subagent_spawn is delivered automatically. Do not poll with subagent_inspect or subagent_mailbox action "read", repeatedly check progress, or duplicate the delegated work.',
	];
}
