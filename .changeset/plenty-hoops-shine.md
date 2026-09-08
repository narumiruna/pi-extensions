---
"@narumitw/pi-usage": patch
---

Report the explicit Z.AI no-GLM-Coding-Plan response as unsupported instead of publishing a usage error to the statusline. Preserve query failures and scheduled retries for malformed quota responses, and omit provider error messages to avoid exposing echoed credentials.
