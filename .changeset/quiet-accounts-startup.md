---
"@narumitw/pi-accounts": patch
"@narumitw/pi-usage": patch
---

Start Pi sessions without waiting for account-file locks or provider activation, while preserving fail-closed authentication by gating each provider's first use, allowing compatible usage queries to await pending activation, and cancelling stale startup work.
