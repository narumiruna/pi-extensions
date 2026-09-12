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

- Maintain a cleanup ledger for the Herdr session with each pane ID you create, its intended lifetime, and, for an agent pane, the assigned agent identity plus the strongest stable session or process identity that Herdr exposes.
- Mark a pane as retained when the user asks to keep, inspect, or use it later, or when its continued existence is part of the requested result, and never close a retained pane automatically.
- For a temporary pane, collect the required output, decide that no follow-up is needed, and clean it up as soon as its work is no longer needed.
- Immediately before cleanup, use the loaded version-specific instructions to read live state and confirm that the pane is still the recorded resource instead of relying on an earlier result or status alone.
- Clean up an agent pane only when its current agent and every recorded stable identity match the ledger and its state is `idle` or `done`; if identity changed or cannot be confirmed, leave the pane open.
- If the recorded agent has exited, or an ordinary command has finished, clean up the pane only after it has returned to an available shell with no replacement occupant or foreground process.
- Use the pane-closing operation documented by the loaded instructions; do not assume command syntax that they do not provide.
- Keep unresolved temporary entries after cancellation or interruption, retry safe cleanup at the next recovery boundary before further Herdr work, and sweep them again before the final response.
- Never close the calling pane, a pre-existing pane, or a pane created by the user or another agent.
- If safe cleanup cannot be confirmed or closure fails, keep the ledger entry and report the pane ID and reason.
