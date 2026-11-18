---
"@narumitw/pi-plan-mode": patch
"@narumitw/pi-tui-kit": patch
---

Fix duplicate option numbers in Plan mode questionnaires in TUI and RPC.
Recognize complete sequences that use `1.` or `1)`, even with leading spaces.
Keep the prefixes if removing them would leave a label with no visible text.
Show predefined option numbers apart from the answer text on the TUI review
page. Leave selected answers unchanged.
