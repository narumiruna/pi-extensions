# Managing goals

[Back to README](../README.md#-commands)

## Start, edit, and replace

Starting a goal begins automatic work and resets its usage counters.
Replacing an unfinished goal requires confirmation; cancelling keeps the previous goal.
If kickoff delivery fails, a new goal is cleared or the previous Goal and tool policy are restored, including its prior active or waiting state.

An edit preserves cumulative usage.
An active edit starts a fresh safety epoch and invalidates stale turns; stopped goals retain their safety state until resumed.
A budget-limited goal reactivates only when `edit --tokens` raises its total budget above current usage.
Failed prompt delivery restores the previous objective, state, safety counters, and tool policy.

For budget selection, units, cancellation, and cost limits, see [Token budgets and elapsed time](../README.md#-token-budgets-and-elapsed-time).
For automatic-work settings, see the [settings reference](./settings.md).

## Pause and resume

`/goal pause` stops automatic continuation and aborts the current turn while preserving the goal.
It applies only to active goals.

Resuming a paused, blocked, usage-limited, or eligible budget-limited goal starts another safety epoch: automatic-response and repetition counters reset, while the objective, cumulative usage, and active elapsed time remain intact.
The command reports the new finite epoch or explicit Unlimited state.
If resume delivery fails, the original stopped state and counters are restored.
Resuming an active waiting goal instead clears its wait without resetting the safety epoch; see [External waiting](../README.md#-external-waiting).

In the TUI, an automatic-work-limit pause offers **Review and continue…**, which previews and confirms another epoch.
Changing the automatic-work limit alone leaves the goal paused; Back or Escape makes no change.
An exhausted token budget must be raised above current usage before work can resume.

## Clear and migrate legacy queues

Menu-driven Clear previews the affected goal and requires confirmation.
Direct `/goal clear` and its `/goal stop` alias clear immediately, including pending continuation and inert legacy queue state, without aborting unrelated in-flight work.
For session persistence and old working-directory state cleanup, see [Session and reload behavior](../README.md#-session-and-reload-behavior).

The experimental ordered-goal queue has been removed.
Use `/goal edit <objective>` to reprioritize one objective instead, for example:

```text
/goal edit task b is complete; do task a next; then continue task c and task d; do not redo task b unless verification shows it is incomplete.
```

Former queue words `add`, `prioritize`, `drop-last`, `skip`, `push`, `unshift`, `pop`, and `shift` are ordinary objective text for unaffected users.
Sessions with legacy queue settings or persisted queue state show a migration warning for those words instead of replacing the active Goal.
