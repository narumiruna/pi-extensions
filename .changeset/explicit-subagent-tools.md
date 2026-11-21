---
"@narumitw/pi-subagents": major
---

Select subagent work tools by exact name. The child Pi validates requested core tools before it receives the task and does not inherit the parent's tool catalog. Neither the core nor the extension tool list accepts CLI patterns or modifiers.

Omitting `tools` now selects no core work tools, just like `tools: []`. To keep the previous read-only default, pass `tools: ["read", "grep", "find", "ls"]` explicitly. Communication tools remain available automatically.
