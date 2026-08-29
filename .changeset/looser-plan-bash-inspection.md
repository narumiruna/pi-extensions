---
"@narumitw/pi-plan-mode": minor
---

Loosen the limited `bash` inspection policy: accept `cd`, read-only Windows diagnostics (`tasklist`, `where`, `hostname`, `ipconfig`, `netstat`, and `wmic` without `call`/`create`/`delete`/`set`), leading `VAR=value` assignments, bare glob patterns, double-quoted `$VAR` references, and stderr sinks (`2>&1`, `2>/dev/null`, `2>$null`).
Accept `cd`, `Get-Process`, and `Get-Service` in the limited `powershell` policy.
Rewrite blocked-command reasons to name the allowed surface and the rejected category so agents adjust the command instead of concluding the shell is disabled, and annotate `bash`/`powershell` as read-only inspection in the Plan policy summary.
Output redirects, command substitution, brace expansion, and all mutating commands stay blocked.
