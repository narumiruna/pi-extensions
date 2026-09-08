---
"@narumitw/pi-usage": patch
---

Show fixed English hints for documented Z.AI business error codes, with HTTP-status and unknown-code fallbacks. Use the top-level code when the nested code is absent. Stop classifying credentials from provider message text or echoing error bodies. Z.AI quota failures now retain the error statusline, request backoff, and scheduled recovery instead of being reported as unsupported. Invalidate the matching cached Z.AI report on query failure so expired backoff retries do not restore stale usage.
