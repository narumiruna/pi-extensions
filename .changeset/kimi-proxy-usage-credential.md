---
"@narumitw/pi-usage": minor
---

Support a dedicated Kimi Coding usage credential for proxy selections. Setting `PI_USAGE_KIMI_CODING_API_KEY` authorizes the fixed official usage endpoint while the selected Kimi model keeps its custom or proxy inference origin; the override re-reads the variable on every resolution, never reads or sends proxy credentials, is ignored for official direct selections, and absent or blank values keep failing closed.
