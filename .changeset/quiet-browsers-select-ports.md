---
"@narumitw/pi-chrome-devtools": patch
---

Select an available nonzero port for default managed browser launches instead of enabling Chrome's port-0 automation signal. Validate startup against the owned browser's DevTools announcement and browser identity, while preserving explicit endpoints, attach-first behavior, and temporary profiles.
