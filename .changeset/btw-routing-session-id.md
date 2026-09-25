---
"@narumitw/pi-btw": patch
---

Send a per-thread routing `sessionId` with side requests so provider overrides that require one, such as subscription attribution transports, no longer reject `/btw`; the main session ID is still used only for OpenCode headers.
