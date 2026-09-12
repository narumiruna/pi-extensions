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

- Record the ID of every pane that you create for the current task; discovering a pane later is not proof that you own it.
- Clean up each owned pane as soon as its work is no longer needed, and sweep owned panes again before the final response.
- Immediately before closing a pane, read its live pane and agent state again instead of relying on an earlier result.
- For an agent pane, first collect the required output and decide that no follow-up is needed, then close it with `herdr pane close <pane-id>` only when the agent is `idle` or `done`; closing the pane also ends that agent.
- If an owned agent has already exited, or an ordinary command has finished, close the pane only after it has returned to an available shell.
- Never close the calling pane, a pre-existing pane, a pane created by the user or another agent, an agent in `working`, `blocked`, or `unknown`, or a pane with another foreground process.
- If safe cleanup cannot be confirmed or the close fails, leave the pane open and report the pane ID and reason.
