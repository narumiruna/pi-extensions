# pi-goal and Plan mode tool-policy interaction

## Problem

Pi exposes one process-wide active-tool array through `setActiveTools()`. The call replaces the whole array; it does not add or remove tools owned only by the caller. pi-goal and pi-plan-mode therefore cannot independently enforce complete tool sets without becoming order-dependent:

1. If pi-goal runs last and re-adds `goal_complete` and `goal_blocked`, it can bypass Plan mode's restrictive selection.
2. If Plan mode runs last, it can remove the terminal Goal tools from an active goal.
3. The Goal prompt asks the model to implement and verify until completion, while the Plan-mode prompt prohibits implementation. Running both autonomous policies at once is contradictory.

Changing extension load order does not solve the ownership problem; it only changes which policy wins.

## Current policy

Restrictive tool modes win. pi-goal must not reassert its tools from `before_agent_start` or otherwise overwrite another extension's complete active-tool selection on every turn.

The visibility setting controls only pi-goal's own baseline behavior:

- `"always"` means pi-goal does not proactively hide its registered tools.
- `"after-first-goal"` means pi-goal hides its tools at fresh runtime startup and reveals them for the first accepted goal activation or an unfinished-goal restore.

Neither value grants pi-goal ownership over the global active-tool array. Plan mode or another restrictive policy may still hide the tools temporarily. Lazy mode may request the tools again during an explicit start or resume, but it does not reassert them on every model turn.

## Fail-safe behavior

An autonomous active goal requires both `goal_complete` and `goal_blocked`. pi-goal checks that invariant at activation, restore, prompt injection, turn completion, and continuation dispatch.

- A new activation or resume is rejected before state changes when both tools are unavailable.
- A restored or running active goal is transitioned to `paused` if the tools disappear.
- Pending continuation work is cancelled, and no new automatic continuation is sent.
- The fail-safe pause path leaves the restrictive active-tool set unchanged.
- After the restrictive mode exits, the user can run `/goal resume`; lazy mode requests its baseline tools again at that explicit activation boundary.

This policy can allow one already-started model call to finish when a later handler removes the tools after pi-goal's pre-turn check. The `agent_end` guard still pauses the goal before it can create an autonomous loop.

## Why this is not a general merger

Tool-policy composition needs a Pi-level API that represents independent constraints or contributions, for example required tools, forbidden tools, and temporary mode ownership. Extensions cannot derive that safely from repeated whole-array replacement.

Until such an API exists, pi-goal deliberately provides failure safety rather than trying to make every extension combination simultaneously active.

## Verification scenarios

Tests should cover both ordering boundaries:

1. A restrictive policy removes Goal tools before pi-goal's `before_agent_start`; pi-goal pauses without injecting Goal instructions or restoring the tools.
2. A restrictive policy removes Goal tools after pi-goal's pre-turn check; `agent_end` pauses the goal and `agent_settled` sends no continuation.
3. A restored active goal cannot enable both terminal tools because of an allowlist; it restores as paused.
4. A new start, resume, or reactivating edit cannot proceed while both terminal tools are unavailable.
