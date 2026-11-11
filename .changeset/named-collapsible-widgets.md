---
"@narumitw/pi-tui-kit": minor
"@narumitw/pi-cache-hit-monitor": patch
"@narumitw/pi-chat": patch
"@narumitw/pi-files": patch
"@narumitw/pi-herdr": patch
"@narumitw/pi-plan-mode": patch
"@narumitw/pi-progress": patch
"@narumitw/pi-subagents": patch
"@narumitw/pi-sync": patch
"@narumitw/pi-ticker": patch
"@narumitw/pi-tool": patch
---

Put editor widget names in their divider lines. In fullscreen Pi, click anywhere in a widget to collapse it to one named line, then click that line to restore the latest content. Preserve independent, session-local disclosure through updates without taking editor focus, changing domain data, or stopping background work. Existing owner controls provide keyboard restoration; regular-mode mouse input remains terminal-owned.

The Kit minor release supplies the named widget state and publisher disclosure APIs. Changesets raises all adopting consumers' Kit dependency floors in the same Version PR. Publish and verify the exact Kit artifact before its consumers.
