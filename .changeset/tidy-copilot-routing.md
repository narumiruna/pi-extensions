---
"@narumitw/pi-btw": patch
---

Honor the API base URL returned by Pi's authentication resolver for both inherited and explicitly configured side-thread models. This fixes misdirected requests for GitHub Copilot accounts that use a different endpoint from the provider default, without changing the main session's model.
