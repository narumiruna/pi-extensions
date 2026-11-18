---
"@narumitw/pi-herdr": minor
---

Add hc (herdr-core) status and terminal ancestry to the agent widget without duplicating Pi's native status reports. Keep legacy Herdr status, `/herdr`, and display of existing session-validated provenance. Do not ship legacy peer spawning or a `pane.run` fallback.

Add the `pi-herdr` skill and `herdr_peer` tool for independent parallel work in hc. The tool requires a valid, complete inherited hc binding. It starts peers with the current Pi runtime's checked absolute Node and Pi CLI paths and the same package resources. Each spawn requires explicit confirmation in an interactive Pi TUI that the local core on that connection was launched by a trusted host with a pre-spawn allowlist for the core's effective program environment. The prompt does not filter that environment or authenticate the endpoint. Headless spawn is rejected.

Use a fresh observation token and canonical terminal address to send peer messages. The tool checks sampled identity and idle status before one conditional send. It does not expose terminal text or raw process arguments, and it cannot prevent draft or takeover races.
