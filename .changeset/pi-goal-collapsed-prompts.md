---
"@narumitw/pi-goal": minor
---

Send every pi-goal prompt (activation, resume, edit, wait-resume, continuation, completion claim) over a custom message channel (`pi.goal.prompt`) with a registered message renderer, so the transcript shows one collapsed line (`goal set: <objective>`) instead of the full prompt text. The model still receives the exact same prompt bytes — `convertToLlm` passes custom message content through verbatim.

Custom-input turns do not fire `before_agent_start`, so run classification (owned prompt / continuation marker / cancelled prompt / workflow ownership) now also runs at `message_start` for `pi.goal.prompt` messages, and the goal-context contract is ensured in the session before the prompt is queued. Goal rotation commands (`/goal`, `/goal edit`, `/goal resume`) cancel pending goal prompts for the rotated-away goal instance so a late kickoff delivery aborts cleanly and schedules a continuation to reclaim the goal. The managed-run RPC start payload accepts `suppressActivationPrompt` so bridge-managed kickoffs can skip the activation prompt entirely.
