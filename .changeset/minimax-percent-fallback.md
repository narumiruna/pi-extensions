---
"@narumitw/pi-usage": patch
---

Render MiniMax Token Plan rows with zero countable quota as percent-based buckets (the API uses `*_remaining_percent` as the canonical indicator) instead of throwing or hiding the row, and surface the actual refresh error in the status chip instead of swallowing it.
