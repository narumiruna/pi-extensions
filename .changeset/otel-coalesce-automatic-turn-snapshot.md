---
"@narumitw/pi-otel": patch
---

Reuse the context usage snapshot when an automatic continuation opens a new trace at turn start, avoiding a second history scan without changing trace metadata.
