---
"@narumitw/pi-inline": minor
---

Rename the package from `@narumitw/pi-inline-markup` to `@narumitw/pi-inline`. The `/inline-markup` command and rendering behavior are unchanged. To migrate, remove the old npm source and install the new one in the same scope (`-l` for project installs). For a local checkout, use `packages/pi-inline` instead. Do not load both copies.
