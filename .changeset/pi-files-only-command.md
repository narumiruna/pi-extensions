---
"@narumitw/pi-files": minor
---

**Breaking change:** `/files` is now the only Pi Files slash command. Replace `/file-context` with `/files` and `/file-context browse` with `/files browse` or the unchanged browser shortcut. For `/file-context remove`, use **Review queued context** in `/files` and remove the snapshot from the next prompt. For `/edit-scope` or `/scope`, use **Manage edit scope** in `/files`. Replace their `off` routes with `/files off` or **End restriction** in scope management.

Update scripts, shortcuts that send command text, and saved instructions: removed slash commands can be sent to the model as prompts.

Settings files, quote format, and version-1 scope snapshots stay unchanged. New active and blocked scope notices point to `/files` without rewriting historical notices.
