---
"@narumitw/pi-starship": patch
"@narumitw/pi-statusline": patch
"@narumitw/pi-inspect": patch
"@narumitw/pi-tool": patch
"@narumitw/pi-ticker": patch
"@narumitw/pi-github-pr": patch
"@narumitw/pi-sync": patch
---

Unreference passive refresh, debounce, expiry, and background startup timers so they do not keep the host process alive when other work has stopped. Keep normal cancellation and resource cleanup unchanged.
