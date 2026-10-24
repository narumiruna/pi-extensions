---
"@narumitw/pi-subagents": minor
---

Add an experimental built-in durable backend, enabled with `{"durable":true}` in user or trusted project settings. Keep the default process-backed jobs, tools, attachments, and messaging unchanged.

Durable mode provides persistent, reusable conversations through native spawn, send, stop, status, and wait tools. It uses the existing Pi session's public model registry, persists stop intents and pending results, and verifies main-session delivery receipts without waking an idle main model. It requires Linux, util-linux `flock`, and a persisted linear Pi conversation. Document its narrower capability support, session ownership, recovery limits, and privileged execution.
