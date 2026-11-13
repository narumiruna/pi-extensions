# Usage-driven account failover

Failover is optional and Off by default. It changes only the current session's account for one provider.
Configure it through `/accounts` → **Settings** → provider, using the enabled, backup-order, and remaining-allowance rows.
Changes save immediately; closing Settings does not undo a saved change.

## Prerequisites and supported evidence

| Usage service | Failover policy | Behavior |
| --- | --- | --- |
| No compatible service | Any | Existing account behavior; no automatic switching |
| Compatible service | Missing or disabled | Existing behavior; no failover usage queries |
| Compatible service | Enabled with backups | Fresh, applicable low allowance can start an ordered attempt |

A compatible service can be supplied by [pi-usage](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage), but it is not a package dependency.
The extensions communicate through the documented [read-only usage protocol](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-usage/docs/api/usage-v1.md).
Installing a service is not enough: its report must include runtime-bound, exact-model included-allowance evidence.
Older services and unsupported provider/auth/model combinations remain usable for manual account selection, but cannot trigger automatic switching.

The initial `pi-usage` path is **OpenAI Codex (legacy), `gpt-5.6-sol`, official Codex Responses authentication**.
Named OAuth and Pi's built-in OAuth can supply the starting account when the effective runtime token and account headers match.
Other models and providers remain non-actionable unless a compatible service can supply the required evidence.
Do not infer support from a provider capability response or a quota percentage displayed in a footer.

Codex base primary and secondary windows describe ordinary included allowance, not a guarantee that a request is blocked.
Paid credits and reserve paths can have different rules. Failover never enables paid usage, redeems resets, changes Fast mode, or changes billing settings.
Opaque additional feature limits prevent a claim of complete constraint coverage. A confirmed applicable low base window can start an attempt, but a candidate with incomplete coverage cannot be accepted as adequate.
The [usage provider guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-usage/docs/providers/openai-codex.md) records the pinned source evidence, transport checks, normalization branches, and limitations.

Anthropic extra spending, unverified OpenAI companion identity, arbitrary Codex model-name matches, and monetary balances are not included-allowance signals.
Meta and Radius currently have no usage adapter. This feature does not add providers or account types.

## Settings

Settings remain user-wide in `<getAgentDir()>/pi-accounts.json`, normally `~/.pi/agent/pi-accounts.json`.
There are no project overrides or new environment variables.
Do not copy this credential file into a repository or replace its existing provider/account fields.

This fragment belongs under a provider, for example `providers.openai-codex`:

```json
{
  "fallback": {
    "enabled": true,
    "accounts": ["personal", "spare"],
    "minRemainingPercent": 5
  }
}
```

- `enabled`: boolean; absent policy means Off. An enabled policy requires at least one backup.
- `accounts`: ordered saved account names under that provider. One name is a single backup; several names form an ordered list. Names must be exact, unique, and not `default`.
- `minRemainingPercent`: finite number from 0 inclusive to 100 exclusive; default 5. Remaining allowance at or below this value is low.

Use Settings to add, remove, or reorder backups and edit the threshold.
The current account can appear in the list but is skipped during an attempt.
A locally removed backup is skipped; an account removed during activation stops the attempt and requires guarded recovery.
You can disable a policy and remove old missing references one at a time. New references must exist, and enabling a policy requires an available backup.
The policy never adds an unlisted account or another provider.

Settings saves use the credential store's existing in-process queue, cross-process lock, private atomic replacement, and unknown-field preservation.
An invalid optional `fallback` block disables that policy, not otherwise valid credentials.
Repair an invalid block manually before saving it through the UI. Malformed credential JSON keeps its existing write protection and authentication recovery behavior.
A failed save does not apply a new runtime policy; the UI reports failure and retains the previous effective value.

Manual edits take effect at session start, including `/reload`. Settings-menu saves apply to the current session after a successful save; other processes and sessions reload their own settings.
Changing a policy never changes the user-wide startup default in `providers.<id>.active`.
`PI_ACCOUNT`, even an invalid value, owns the effective selection and disables automatic switching. Its existing fail-closed rules remain unchanged.

RPC Settings reports the manual settings path instead of opening terminal UI.
`/accounts` retains its existing TUI/RPC account-manager behavior and ignored arguments; print and JSON modes still provide no account-manager output.
**Status** shows policy order, threshold, restrictions, and the last check/switch result. **Help** explains the optional-service behavior.
A configured policy can be saved without a usage service; the next check reports that automatic failover is unavailable without changing authentication.

## Decision and request ordering

A decision is low, adequate, or unknown. Only low authorizes a candidate attempt.
Reports must be fresh refresh results, belong to the exact session/provider/runtime authentication, and explicitly cover the selected model.
Only referenced percentage included-allowance constraints participate. Independent windows are not averaged.
Complete applicable coverage is required to accept an adequate candidate; partial coverage can prove a specific low constraint but cannot prove adequacy.

Missing, malformed, contradictory, expired, unbound, or unscoped data is unknown.
A usage error, timeout, authentication failure, HTTP 429, generic rate limit, or provider outage is never a switching trigger.
Account labels, bucket labels, group names, and display heuristics are not identity or model-scope evidence.

Pi awaits the account-owned `turn_start` gate before preparing the model request, even though `ctx.isIdle()` is false.
The gate performs these operations in order:

1. Verify existing authentication and continuation cleanup.
2. Check the enabled policy, process override, and request ownership before querying usage.
3. Obtain fresh current-account evidence. No service, adequate allowance, or unknown evidence leaves the selection unchanged.
4. After proven low allowance, activate the next configured candidate and verify its effective authentication and the same model.
5. Query that candidate's current runtime usage. Accept adequate allowance; another proven low result permits the next candidate.
6. Stop on unknown data or an activation error. If no candidate is accepted, restore the original selection and verify authentication before releasing the request gate.

The usage protocol cannot query an inactive named account.
Candidate activation changes runtime authentication, not the saved session choice. Trial choices stay in session-owned memory.
Only an adequately verified backup is saved as the accepted choice. Other provider selections cannot include an unaccepted trial in their saved snapshot.
No model request is sent under an unverified candidate. There is no automatic replay of a request, completed tools, or an entire agent run.
The model, provider, prompt, history, and ordered tool definitions do not change. Account changes use Pi's existing session continuation cleanup before the next request.

Checks are paced to at most one attempt per five minutes for unchanged model/authentication/policy/selection state.
Each usage query has a 15-second cap. An attempt has 45 seconds for normal work, followed when necessary by up to 14 seconds for restoration and 1 second for fail-closed publication.
An unavailable service returns immediately rather than waiting for the query deadline.
No background polling or automatic refresh loop is added. Usage notifications do not cause recursive refreshes.

A confirmed-low account is excluded until all known low constraints reset. If a reset is unknown, explicit selection, a settings change, or a new session is required to clear that exclusion.
Reset expiry makes a future low-current-account attempt eligible; it does not automatically return to a preferred account.
Manual and protocol selections supersede pending automatic work. A later automatic decision needs fresh evidence for the new selection.

## Recovery

Successful switching stays in the current session's existing selection record and survives resume or reload.
Other sessions and startup defaults do not change. New sessions keep their existing default-snapshot rules.

Disabling failover cancels pending decisions. Policy reload also suspends automatic decisions before reading storage; a failed read cannot keep an old enabled policy active.
Disabling does not switch back after an already accepted change.
Use the existing account picker to choose another account explicitly.

Restoration clears the trial choice and verifies the last accepted account. It must never overwrite a newer manual selection or restore old OAuth token bytes.
Recovery reads current shared credentials and uses the existing authentication verification and connection cleanup. It does not add a trial or recovery choice to session history.
If recovery cannot verify authentication, the provider remains blocked and the current run is aborted; select an account from `/accounts` to recover.
Deferred recovery uses `agent_settled`, not `agent_end`.

Session replacement and shutdown cancel owned work and prevent stale publication or restoration against another session.
Reload and process resume restore the last accepted choice, even when the policy is disabled or the usage service is absent. They do not depend on the old owner's cleanup.
Explicit manual and protocol selections retain their existing persistence-before-activation behavior; the accepted-only rule applies to automatic trials.
Older development builds did not mark an interrupted trial in saved entries. This change prevents new unaccepted choices from being saved; it cannot infer or rewrite old unmarked choices. Review such a saved choice explicitly when updating from an older development build.
Reverting this feature does not remove existing session choices or credentials. Disable the policy and select the intended account before rollback.

## Implementation evidence and external verification

The runtime audit covers initial prompts, tool-loop requests, queued continuations, cancellation, and final settlement.
Installed Pi awaits extension `turn_start` handlers before `prepareRequest` and provider streaming; `agent_end` can precede retries and continuations, while `agent_settled` starts at idle.
Pi defers prompts submitted during settlement. However, a prompt already waiting in an input hook can start during a settled handler.
Recovery checks the current recovery record after each wait. Old recovery cannot replace newer verified authentication. The settled loop checks idle state before each provider so it cannot undo a new active trial. A failed recovery blocks its own provider; it does not abort another provider's active run.
Automatic activation uses the existing account-owned sync with its pre-request cleanup permission, not the public activation protocol's out-of-boundary behavior.
OAuth readiness waits for authentication sync, not the failover query itself, so usage reads do not create a readiness cycle.

Deterministic tests cover settings validation/storage, native settings UI behavior, independent usage protocol validation, low/adequate/unknown decisions, real runtime authentication, cancellation and replacement, guarded restoration, generated loading, and synthetic model-visible prefix stability.
They do not prove live entitlement, accounting delay, or web-console agreement.

Account owner: optional live comparison requires locally authenticated primary and backup accounts for a supported model, known quota windows, and approval for provider traffic.
Compare quota/reset data with the provider console, confirm each account's model entitlement, then verify real account switching and continuation behavior.
Expected result: only the intended included-allowance threshold and account/model scope cause switching, without changing paid usage policy.
Live accounting delay, quota enforcement, paid-extra behavior, entitlement, and real switch continuity remain unverified until that comparison is completed.
Do not send credentials in chat. Stop after one clear external entitlement failure; do not repeatedly consume account quota.
Do not claim broader provider coverage or enable unproven paths based only on fixture tests.

Maintainer: publishing, tags, visibility changes, and release workflow dispatch still require separate approval.
