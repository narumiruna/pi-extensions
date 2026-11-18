---
"@narumitw/pi-sync": patch
---

Treat an empty session path as absent instead of invalid, so `pi --no-session` runs stop reporting `Pi session paths must be absolute` on startup while still syncing nothing for that ephemeral session.
