---
"@narumitw/pi-accounts": patch
---

Clear Pi session resources when a built-in provider's applied account identity changes, including Anthropic message threads and opt-in compatible gateways. Defer cleanup to an idle or pre-request boundary, cancel active work when authentication changes too late for that boundary, and preserve continuation state for unchanged authentication.
