---
"@narumitw/pi-subagents": major
---

Add optional `provider` and `model` parameters to `subagent_spawn`. Each omitted value inherits independently from the effective parent model at spawn time. Explicit IDs use exact matching without fallback, including listed case-distinct and provider-prefixed IDs, and every child confirms its registered chat model and current provider availability before receiving the task.

Unlisted custom model IDs previously accepted through Pi's CLI now fail, including inherited IDs. Register each exact model in Pi's `models.json` or attach a trusted extension that registers it in the child. Parent-only providers, runtime API keys, and virtual routing state are not forwarded. Reload or replace the session after upgrading to load the new tool schema.
