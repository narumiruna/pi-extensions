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

- Maintain an in-context cleanup ledger with each pane ID you create, its intended lifetime, and, for an agent pane, the assigned agent identity plus the strongest stable session or process identity that Herdr exposes.
- Mark a pane as retained only when the user explicitly asks it to remain open after the task for later inspection or use, or when its continued existence is itself part of the requested result, and never close a retained pane automatically.
- For a temporary pane, collect the required output, decide that no follow-up is needed, and attempt cleanup as soon as its work is no longer needed.
- Automatically close a pane only through an operation documented by the loaded instructions that atomically checks the recorded pane and occupant identity together with an acceptable live state at mutation time.
- For an agent pane, the atomic guard must match every recorded stable identity and require `idle` or `done`; for a returned shell, it must require no replacement occupant or foreground process.
- A separate state read followed by an unconditional close is unsafe; if the installed Herdr version provides no suitable guarded close, leave the pane open and report that limitation.
- Keep unresolved temporary entries after cancellation or interruption while the current model context survives, retry guarded cleanup at the next recovery boundary before further Herdr work, and sweep them again before the final response.
- Never close the calling pane, a pre-existing pane, or a pane created by the user or another agent.
- If guarded closure fails, keep the ledger entry and report the pane ID and reason.
