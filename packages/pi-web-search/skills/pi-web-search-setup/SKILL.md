---
name: pi-web-search-setup
description: Guide Cloudflare account, API token permissions, gateway billing, and safely edit pi-web-search.json only when the user explicitly invokes /skill:pi-web-search-setup; not for ordinary searches, automatic error recovery, or extension development.
disable-model-invocation: true
---

# Set up pi-web-search

Assist only with the setup or settings changes requested by the user who invoked this skill.
For an explanation-only request, do not inspect or modify user files.
For an underspecified edit, ask one question with numbered options before writing.
Do not install packages, change Pi's settings.json, purchase credits, create cloud resources, or run a paid search without separate user approval.
Stop when the requested setup or edit is complete; do not keep applying this workflow to later unrelated requests.

## Cloudflare prerequisites

Direct the user to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) and choose Create Token → Create Custom Token.
Require Account → Workers AI → Read and Account → AI Gateway → Read, with Account Resources limited to the specific account used for searches.
Do not request Edit, Zone, or Global API Key access.
Explain that IP restrictions must permit the Pi machine's outbound IP and expired tokens must be renewed.
Use the account's 32-character hexadecimal Account ID, not a Zone ID.
Confirm an AI Gateway ID, normally `default`, and either AI Gateway credits or a Ceramic.ai key stored in that gateway's Provider Keys.
This extension only uses Ceramic.ai, even if Cloudflare supports additional providers.
With an explicit `byokAlias`, missing provider-key configuration fails rather than falling back to credits.
Without an alias, the gateway uses Ceramic.ai's `default` key if present, otherwise credits.
When dashboard labels or service availability differ, consult [Cloudflare's current setup documentation](https://developers.cloudflare.com/web-search/how-to-use/) without sending credentials.

## Credential boundary

Never ask the user to paste an API Token into the conversation, tool arguments, or a shell command.
Never use read, cat, a diff, or any other raw-output tool on pi-web-search.json because it contains credentials.
Do not print loaded settings, unknown fields, parser errors, or exception objects.
Keep any existing `apiToken` unchanged during agent-assisted edits.
For initial setup or token replacement, ask the user to insert the token locally using their trusted editor outside the agent tools.
The `/web-search` UI cannot accept tokens because Pi's input dialog does not mask them.
If a token was exposed in the conversation, recommend revoking it and creating a replacement without repeating its value.

## Inspect and edit safely

Resolve the active path through the installed package's `settingsFilePath()`, which uses Pi's `getAgentDir()`; the usual path is `~/.pi/agent/pi-web-search.json`.
There are no project overrides or extension-specific environment aliases.
Use the package-owned SettingsStore and normalizeSettings in `src/settings.ts` as the authoritative persistence and validation implementation, not a separately reconstructed writer.
Resolve that source file relative to this skill directory as `../../src/settings.ts` and convert its absolute path to a file URL when importing it.
Run the following JavaScript with `node --experimental-strip-types --input-type=module`, substituting only the installed source file URL and the user's requested non-secret patch.
For inspection, leave the patch empty; a missing-file load must not create a file or directory.
The patch below is deliberately empty and must not be treated as a request to save defaults.

```js
const { SettingsStore, settingsFilePath } = await import("file:///ABSOLUTE_PACKAGE_PATH/src/settings.ts");
const patch = {};
const allowed = new Set(["accountId", "gatewayId", "exposure", "limit", "timeoutMs", "byokAlias"]);
try {
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new Error();
  const store = new SettingsStore();
  const current = Object.keys(patch).length ? await store.save(patch) : await store.load();
  console.log(JSON.stringify({
    path: settingsFilePath(),
    saved: Object.keys(patch).length > 0,
    accountIdPresent: Boolean(current.accountId),
    apiTokenPresent: Boolean(current.apiToken),
    gatewayId: current.gatewayId,
    exposure: current.exposure,
    limit: current.limit,
    timeoutMs: current.timeoutMs,
    byokAlias: current.byokAlias,
  }));
} catch {
  console.error("Settings operation failed; check values, regular-file status, size, and POSIX permissions 0600 locally.");
  process.exitCode = 1;
}
```

Pass only explicitly requested changes, preserving credentials, omitted preferences, and unknown fields.
Do not use whole-file write or edit tools, emit a full JSON replacement, or make a backup that exposes credentials.
If the installed source or a TypeScript-capable Node runtime is unavailable, stop agent-assisted writes and provide manual instructions instead of inventing a persistence implementation.
Malformed, invalid, oversized, symlinked, nonregular, or insecure existing files must block edits; ask the user to repair them locally rather than overwrite them.
On POSIX, the file must have exact `0600` permissions; ask permission before a targeted chmod repair and never change existing parent directory permissions.
Ask the user to avoid simultaneous edits in another Pi process or editor because SettingsStore only serializes writes in-process.

| Field | Accepted values | Default |
| --- | --- | --- |
| `accountId` | 32 hexadecimal characters; empty while unconfigured | Empty |
| `gatewayId` | 1–64 letters, digits, underscores, or hyphens | `default` |
| `exposure` | `codemode`, `direct`, `deferred`, `model-only`, `hidden` | `codemode` |
| `limit` | Integer 1–10 | `5` |
| `timeoutMs` | Integer 1,000–120,000 | `30000` |
| `byokAlias` | Empty, or 1–64 letters, digits, underscores, or hyphens | Empty |

Do not select `hidden`, `deferred`, or `model-only` for an ordinary Codemode setup unless the user specifically wants that exposure.
Default `codemode` exposure requires Pi's built-in Codemode tool to be enabled separately; offer to merge `+codemode` into defaultTools without discarding existing selections only with approval to edit Pi settings.
Use `direct` when the user wants the model to call web_search without Codemode.

## Verify and hand off

After saving, reload with SettingsStore.load() and report only changed non-secret fields and credential presence.
Explain that a successful save validates local settings but does not prove Cloudflare authorization, gateway availability, or billing readiness.
Ask the user to run `/reload` or restart Pi, then use `/web-search` → Status to check the active configuration.
Changing exposure is an intentional tool-definition transition, not ordinary-turn automatic activation.
Offer one benign live search only after warning that queries leave the machine and may incur charges, and obtaining approval.
Stop after one clear access, entitlement, or billing failure and guide the user to check the token's two Read permissions, account resource scope, gateway, credits, and BYOK alias rather than retrying automatically.
Report the settings path, completed changes, required local token step if any, and any unverified live access.
