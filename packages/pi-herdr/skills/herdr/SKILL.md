---
name: herdr
description: "Control Herdr, a terminal multiplexer for coding agents. Use only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control panes, tabs, workspaces, commands, or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work. Requires HERDR_ENV=1."
---

# Herdr

Before the first Herdr control command in a session, check whether the complete output of `herdr --skill` is already present in the current context.
If it is present, reuse it and do not load it again.
Otherwise run this single shell call:

```bash
test "${HERDR_ENV:-}" = 1 || {
	printf '%s\n' "Not running inside Herdr." >&2
	exit 1
}
herdr --skill
```

If the environment check or command fails, report the error and stop.
Read the returned skill completely and follow it as the authoritative operating instructions for the installed Herdr version.
Run it again only after compaction removes those instructions or when the user explicitly asks to refresh them.

Apply this cleanup policy in addition to those version-specific instructions:

- Track every pane that you create for the current task.
- Treat `idle` and `done` as ready states, not proof that a pane is disposable.
- After collecting the result and deciding that no follow-up is needed, inspect an agent again and close its pane with `herdr pane close <pane-id>` only when the agent is still `idle` or `done`; closing the pane also ends that agent.
- Close an ordinary command pane only after its command has finished and the shell is available again.
- Never close the calling pane, a pre-existing pane, or a pane created by the user or another agent.
- Never close an agent in `working`, `blocked`, or `unknown`; leave it open and report why cleanup was deferred.
- Before the final response, make a cleanup pass over panes you created so completed background work does not remain open.
