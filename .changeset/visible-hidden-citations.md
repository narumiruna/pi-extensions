---
"@narumitw/pi-inline-markup": patch
---

Style and preview explicit Markdown file links to hidden workspace paths such as `.github/workflows/ci.yml`. Wikilink lookup still skips hidden paths, and previews still exclude `node_modules`, symbolic links, and files outside the workspace.
