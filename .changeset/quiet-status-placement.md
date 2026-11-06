---
"@narumitw/pi-starship": minor
---

Place individual public extension statuses with `${extension_status.<raw-key>}` in the root format. Aggregate statuses, including those reached through `$all`, exclude explicitly placed keys. Individual references reuse the existing status format, icons, and per-key styles without changing producer keys or saved settings. Omit status content that becomes empty after formatting so it cannot consume the limit or leave static decoration.
