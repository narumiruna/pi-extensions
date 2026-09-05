---
"@narumitw/pi-lsp": patch
---

Cancel and drain session-owned LSP calls during shutdown and reload, including partially initialized servers. Keep resource cleanup independent of status UI failures, preserve original operation errors, and prevent cancelled continuations from writing fixes or starting another diagnostics route. Share client lifetime handling between diagnostics and fixes.
