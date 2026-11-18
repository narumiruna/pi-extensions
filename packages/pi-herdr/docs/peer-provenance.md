# Legacy Herdr peer provenance

The legacy Herdr widget can show existing session-validated spawn records. `pi-herdr` does not write these records or provide a legacy peer launch or messaging path. Legacy Pi status reporting and `/herdr` remain available. There is no `pane.run` fallback. For peer work, use the [hc integration](hc-integration.md).

## Record format

The reader recognizes five public Herdr pane tokens. Existing records used source `pi-herdr:spawn:v1` and no time to live (TTL):

| Token | Value |
| --- | --- |
| `pi_spawn_v` | Protocol version `1`. |
| `pi_spawn_origin` | Initiator's terminal ID, at most 80 Unicode characters. |
| `pi_spawn_from` | Initiator's session fingerprint. |
| `pi_spawn_to` | Started peer's session fingerprint. |
| `pi_spawn_label` | Captured initiator name or pane ID, at most 80 Unicode characters. |

A fingerprint is the lowercase hexadecimal SHA-256 digest of UTF-8 `JSON.stringify([terminal_id, source, agent, kind, value])`, using the public `agent_session` reference. This version accepts only `herdr:pi` / `pi` references with kind `id` or `path`. The record contains the digest, not the raw session path or ID. The digest is a correlation key, not authentication or a guarantee of anonymity.

Herdr tokens share a terminal-level map across sources. A source scopes sequence handling, not token ownership. Another caller can overwrite a token. Records without a TTL remain until a caller overwrites or clears them, or the pane closes. Herdr does not restore them after a server restart.

## Display rules

The widget ignores unsupported, incomplete, self-referential, cyclic, or target-mismatched records. It resolves origins against the complete session snapshot before it excludes the current pane or applies the row limit. It does not infer a relationship from a name or pane layout.

A move or rename preserves the relationship if the terminal and session identities still match. A new target session cannot inherit an old relationship. If the origin is absent, ambiguous, or replaced, the widget uses the captured label and marks it unavailable. It does not attach the record to a different session in the same terminal.

The widget keeps its flat, status-ordered list of at most five agents. It shows the labels `spawned by you`, `spawned you`, or `spawned by <peer>` as secondary text. A label does not grant authority or show who controls the process.

## Refresh ordering

Token changes emit `pane.updated` and cause a fresh read. A session reference update alone does not always emit an event. After each Pi session report completes, the extension refreshes the existing five-key display metadata, which has a TTL. This causes observers to read the current session identity again without polling or adding a token.

The widget uses the latest completed snapshot and can briefly lag new events. The earlier caller lookup supplies an ID. The later pane list supplies the current pane and peer identities together. If the caller is missing, the widget looks up the topology again instead of reusing the earlier identity. Reporting is best-effort: a Herdr acknowledgement does not guarantee that Herdr applied the session identity report.

Deterministic checks cover record validation, session replacement, and widget refresh. Physical terminal rendering remains unverified.
