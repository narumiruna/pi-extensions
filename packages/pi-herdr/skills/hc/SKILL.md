---
name: hc
description: "Control persistent terminals and coding agents through the Herdr Core hc CLI. Use only when the user explicitly mentions hc, Herdr Core, or herdr-core, or asks to use them to run programs, delegate tasks, inspect terminals, or send input. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work."
---

# Herdr Core

`hc` controls Herdr Core terminals, not legacy Herdr panes.
It does not require a Herdr-managed pane or `HC_TERMINAL_ID`.

Before the first hc control command in a session, check whether the complete output of `hc --skill` is already present in the current context.
If it is present, reuse it and do not load it again.
Otherwise run this single shell call:

```bash
hc --skill
```

If the CLI is unavailable or the command fails, report the error and stop without falling back to `herdr`.
Read the returned skill completely and follow it as the authoritative operating instructions for the installed Herdr Core version.
If the output is truncated, retrieve the complete guidance before running a control command.
Run it again only after compaction removes those instructions or when the user explicitly asks to refresh them.
