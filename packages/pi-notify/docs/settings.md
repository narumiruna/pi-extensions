# Notify settings and behavior

Use `/notify` for setup or edit the canonical user JSON file. Settings load on session start, including reload and session replacement. Reads do not create files. Successful menu saves apply immediately; manual file edits need `/reload` or another session start.

## Fields and scope

| Field | Accepted values | Default | Scope |
| --- | --- | --- | --- |
| `enabled` | Boolean | `true` | User or trusted Project |
| `mode` | `immediate`, `after-inactivity` | `immediate` | User or trusted Project |
| `inactivitySeconds` | Whole number from 1 to 86400 | `30` | User or trusted Project |
| `targetIds` | Array of unique existing destination IDs, at most 32 | Empty | User or trusted Project |
| `destinations` | Object keyed by stable IDs, at most 32 | Empty | User only |

Destination IDs contain 1–64 ASCII letters, digits, underscores, or hyphens, starting with a letter or digit; `constructor`, `prototype`, and `__proto__` are reserved. The menu creates IDs automatically.

Telegram setup requires a bot token and chat ID; Gotify setup requires an application token and server URL; Slack setup requires a complete Incoming Webhook URL. The other providers use the [fields below](#new-provider-fields). Add destinations through the provider-choice screen in `/notify`. The menu generates a label and opens a review for edits before saving. Editing an existing destination opens the same review with its current values. Destination changes take effect only after confirmation. For a new destination, Save and use adds it to User `targetIds` in the same atomic save; Save only stores it without selecting it. Editing an existing destination preserves its selection state. Explicit Project selections and saved `enabled: false` values are unchanged. Automatic notifications default to On; Off pauses automatic delivery but still allows manual tests. No delivery occurs without a selected destination.

Each Telegram destination has `provider: "telegram"`, a nonempty `label` of at most 128 characters, `botToken`, a numeric string `chatId`, and optional positive safe-integer `messageThreadId`. A group or supergroup ID can be negative. Store IDs as strings, not JSON numbers. Forum topic IDs use Telegram's `message_thread_id` field. Other Telegram chat products with additional required fields are not supported.

Each Gotify destination has `provider: "gotify"`, a nonempty `label` of at most 128 characters, `serverUrl`, `appToken`, and optional `priority`. Use an application token created in the server's Apps tab, not a client token or password. Tokens must contain 1–512 printable ASCII characters without spaces. Server URLs must be absolute HTTP(S) URLs, at most 2048 characters before and after URL normalization, without whitespace, control characters, backslashes, credentials, query strings, or fragments. Include any reverse-proxy base path; do not append `/message`. Trailing slashes are removed on save. HTTP is supported for self-hosted deployments but does not encrypt credentials or metadata; prefer HTTPS. Priority must be a safe integer (including zero or negative values). Leave it unset to use the application's default priority; clear the field in review to restore that default.

```json
{
  "targetIds": ["gotify"],
  "destinations": {
    "gotify": {
      "provider": "gotify",
      "label": "Personal Gotify",
      "serverUrl": "https://push.example.com/gotify",
      "appToken": "<application-token>",
      "priority": 5
    }
  }
}
```

Each Slack destination has `provider: "slack"`, a nonempty `label` of at most 128 characters, and `webhookUrl`. The complete URL is a credential and belongs only in the canonical User file. The channel comes from the webhook installation, not the label or a settings field. URLs must be at most 2048 characters and match `https://hooks.slack.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+` exactly: a `T` workspace segment, a `B` installation segment, and an alphanumeric secret. Ports, URL credentials, query strings, fragments, redirects, alternate hosts, whitespace, control characters, backslashes, and encoded or normalized URL alternatives are rejected. GovSlack is not supported.

A User file can select all ten providers together. For example, with existing `personal` Telegram and `gotify` destinations, add a Slack destination and select their IDs:

```json
{
  "targetIds": ["personal", "gotify", "build-channel"],
  "destinations": {
    "build-channel": {
      "provider": "slack",
      "label": "Build channel",
      "webhookUrl": "https://hooks.slack.com/services/<workspace>/<installation>/<secret>"
    }
  }
}
```

This fragment shows the Slack addition, not a replacement for the complete User document. Retain the existing destination entries; replace the placeholder URL with the exact URL from Slack. Never put it in Project settings, source control, or Pi chat. No SDK, OAuth flow, bot token, or extension-specific environment variable is used. Saved destinations keep their provider; create a new destination to change providers.

Resolve defaults, User fields, then trusted Project overrides. Project arrays replace rather than merge. Project files cannot define destinations or credentials. Unknown provider IDs do not fall back to Telegram. Invalid fields, unreadable files, unsupported destinations, or missing selected IDs produce diagnostics and disable automatic delivery until repaired; no partial routing is attempted.

Project Settings show inherited values and allow restoring inheritance. Removing a destination clears its User selection atomically, but is blocked if the current trusted Project explicitly selects it. Change that Project selection first. Other projects are not edited; repair their selected IDs before enabling notifications there.

## New provider fields

All destinations require `provider` and a nonempty `label` of at most 128 characters. Destinations, addresses, and credentials belong only in `<getAgentDir()>/pi-notify.json`, normally `~/.pi/agent/pi-notify.json`. Trusted Project files at `<workspace>/.pi/pi-notify.json` can change policy or select existing User destination IDs, but cannot define endpoints or secrets.

| Provider | Required fields besides `provider` and `label` | Optional fields |
| --- | --- | --- |
| `ntfy` | `serverUrl`, `topic` | `accessToken`, `priority` |
| `pushover` | `appToken`, `userKey` | None |
| `discord` | `webhookUrl` | None |
| `bark` | `serverUrl`, `deviceKey` | None |
| `webhook` | `webhookUrl` | `bearerToken` |
| `line` | `channelAccessToken`, `recipientId` | None |
| `teams` | `webhookUrl` | None |

For ntfy and Bark, enter the server base URL including any reverse-proxy base path. Do not append the topic or `/push`. Generic `webhookUrl` is the complete receiving endpoint. These configurable URLs must be absolute HTTP(S) URLs, at most 2048 characters both before and after normalization. URL user information, whitespace, control characters, encoded controls, backslashes (including encoded backslashes), malformed percent escapes, query strings, and fragments are rejected. Bark server bases remove trailing slashes before appending `/push`. ntfy publish URLs and Generic webhook endpoints preserve trailing slashes because they can select a different route. Literal or encoded dot segments and noncanonical numeric IPv4 aliases are rejected instead of silently selecting a different path or host. Prefer HTTPS; HTTP does not encrypt credentials or metadata. Explicit local/private addresses are allowed and can reach the Pi host's network. Use only trusted endpoints.

The ntfy `accessToken`, Bark `deviceKey`, and Generic `bearerToken` each have a local limit of 1–512 printable ASCII characters without spaces. This is a header/key safety limit, not a promise that a service accepts every such value. Omit optional credentials in JSON; in review, leave the replacement input empty to clear them. Empty strings are not stored credentials. ntfy and Generic webhooks support only anonymous or Bearer authentication, not Basic, URL credentials, arbitrary headers, or query-based authentication. No custom templates, scripts, or extension-specific environment variables are supported.

### ntfy

`topic` must match `[-_A-Za-z0-9]{1,64}`. Reserved names are `docs`, `static`, `file`, `app`, `metrics`, `account`, `settings`, `signup`, `login`, and `v1`; the check is case-sensitive. A self-hosted server can forbid additional names. `priority`, when present, must be an integer from 1 to 5; an omitted or cleared priority uses the server default.

The transport sends JSON directly to the normalized server base URL, with `topic`, `title`, `message`, and optional `priority`. A configured `accessToken` is sent only as a Bearer header. Title and body are clipped to 1024 and 4096 UTF-8 bytes. The complete encoded JSON request is also capped at 8192 bytes; escaping can reduce the available body length. Only HTTP 200 with a message object counts as accepted. That object must have a nonempty string `id`, positive safe-integer `time`, `event: "message"`, the expected `topic`, and a string `message`.

Topic secrecy is not access control. Without server authentication and topic permissions, public topics can expose metadata and allow unwanted publishers. An ntfy access token has the user's full access; it is not a topic-scoped credential. Configure server ACLs, use a suitably restricted user, and protect the token.

### Pushover

`appToken` and `userKey` must each contain exactly 30 ASCII alphanumeric characters. Pushover uses the fixed HTTPS endpoint `https://api.pushover.net/1/messages.json`; no server URL is configurable. It sends JSON fields `token`, `user`, `title`, `message`, and `priority: 0`. There is no emergency priority, acknowledgement, retry parameter, or configurable priority.

The local title and body caps are 250 and 1024 UTF-16 code units. These are conservative bounds for the service's character limits; astral characters use two code units. Only HTTP 200 with numeric JSON `status: 1` counts as accepted.

### Discord

`webhookUrl` must use one of these exact official endpoint shapes, with a positive decimal webhook ID (no leading zero, at most 20 digits and at most 18446744073709551615) and a nonempty alphanumeric, underscore, or hyphen token:

```text
https://discord.com/api/webhooks/{id}/{token}
https://discord.com/api/v10/webhooks/{id}/{token}
```

The complete URL is a credential. Alternate hosts, ports, URL credentials, queries, fragments, encoded or normalized alternatives, controls, and backslashes are rejected. The transport adds `wait=true` internally, but configured URLs must have no query string.

Discord receives title and body as `content`, clipped to 2000 UTF-16 code units. Requests set `allowed_mentions: { "parse": [] }` and `flags: 4` (`SUPPRESS_EMBEDS`), even for direct provider callers. This prevents mention parsing and link previews; it does not suppress notifications. A descriptive User-Agent identifies the integration. Only HTTP 200 with a Message response containing valid positive decimal `id` and `channel_id` values under the same ID bound and an integer `type` counts as accepted. Normal text-channel webhooks are supported; forum/media channels and thread selection are not.

### Bark

`serverUrl` can be `https://api.day.app` or a self-hosted server base, including a reverse-proxy path. JSON is sent to `<serverUrl>/push` with `device_key`, `title`, and `body`. The key and message are never placed in a URL path or query. The device key is the only supported Bark credential; there is no Bark bearer field. Servers that require Bark's native Basic authentication are not supported. A separate proxy is outside this integration's contract.

Local title and body caps are 256 and 2048 UTF-8 bytes. The encoded `{title,body}` object is capped at 3000 bytes to leave space within Apple's 4096-byte APNs envelope. These are conservative local limits, not universal server limits. Only HTTP 200 with numeric JSON `code: 200` counts as accepted. JSON delivery avoids URL exposure but does not prevent the official Bark server from logging request bodies, including device keys and metadata.

### Generic webhook

`webhookUrl` is masked in full, even without a token. Optional `bearerToken` is sent as `Authorization: Bearer <token>`. The fixed JSON payload contains only:

```json
{
  "id": "notification-id",
  "title": "Pi notification title",
  "body": "Notification metadata",
  "settledAt": 1792281600000
}
```

`settledAt` is Unix epoch milliseconds, not seconds. No internal emphasis, destination credentials, or configurable fields are added. Any HTTP 2xx response counts as endpoint acceptance, including empty or non-JSON responses, after the bounded response read completes. This is not proof of downstream delivery. An oversized or stalled 2xx response body can still fail with `response` or `timeout`.

### LINE

Use `provider: "line"`, a `channelAccessToken`, and a `recipientId`. LINE Notify tokens and public LINE IDs are not accepted. The token must contain 1–8192 characters in the Bearer token alphabet (`A–Z`, `a–z`, digits, `-._~+/`, with optional trailing `=`), without whitespace. The 8192-character cap is a local header safety bound, not a LINE service limit. A user ID must match `U[0-9a-f]{32}`. Group and room IDs must start with `C` or `R`; the provider accepts an opaque suffix of 1–128 printable ASCII characters without spaces. Both the ASCII restriction and suffix cap are local safety policies, not a claimed LINE group/room ID grammar. Use the complete ID from LINE, not a shortened example. The token and raw recipient ID stay hidden in all menus, previews, Status, and errors.

The transport posts one `{ "type": "text", "text": "..." }` message to `https://api.line.me/v2/bot/message/push`, with the recipient in `to` and the token only in the Authorization header. Title and metadata body are combined, terminal controls removed, and text clipped to 5,000 UTF-16 code units, including an ellipsis when clipped, without splitting Unicode code points. No mention objects, formatting, silent-delivery fields, or emphasis offsets are sent. Client automatic links are not suppressed.

Only HTTP 200 with a legacy empty JSON object or a valid current `sentMessages` response counts as accepted. The current response must contain 1–5 message objects with a nonempty string or nonnegative integer `id`; `quoteToken` is an optional string. Empty/non-JSON, unrelated, malformed, or oversized success bodies fail safely. HTTP 429 can indicate a rate limit or an exhausted account allowance; retry-after is diagnostic only and no retry occurs.

For example, add this fragment to the existing User document and include `line-personal` in `targetIds` if automatic notifications should use it. Replace both private placeholders outside Pi chat; do not replace unrelated destinations or settings.

```json
{
  "destinations": {
    "line-personal": {
      "provider": "line",
      "label": "Personal LINE",
      "channelAccessToken": "<channel-access-token>",
      "recipientId": "<complete-user-group-or-room-id>"
    }
  }
}
```

Recipient eligibility and message allowances apply. A user generally must be a friend of the Official Account or have messaged it in a one-to-one chat within the past seven days; group/room delivery requires the account to participate. HTTP 200 does not prove receipt: blocked or deleted accounts and ineligible users can still produce acceptance without delivery. Monthly allowances, pricing, and group message counting depend on the account's region and plan. Check the account before enabling automatic notifications. The extension does not obtain recipient IDs, run an inbound webhook, inspect quota, or manage account access.

### Microsoft Teams

Use `provider: "teams"`, a `label`, and `webhookUrl`. This supports the commercial Teams Workflows trigger **When a Teams webhook request is received**, with **Anyone** authentication only. No Authorization header is sent. The complete signed URL, including its host, path, and query, is a credential. It is never shown in menus, reviews, test previews, Status, or errors. Keep it only in User settings; never paste it into Pi chat or Project settings.

**The current Teams integration has not been verified live.** The following is an explicit supported client policy awaiting live interoperability verification, not a complete Microsoft endpoint grammar or a resolved global response contract. Microsoft documents trigger authentication, payload examples, and URL migration, but observed URL examples do not define every possible service URL.

The local validator accepts only:

- A URL of at most 8192 characters, with the exact lowercase `https://` scheme and one or more lowercase DNS labels before `.environment.api.powerplatform.com`. Each label contains 1–63 lowercase ASCII letters, digits, or hyphens and starts and ends with a letter or digit; the complete hostname is at most 253 characters. Only an omitted port or explicit `:443` is allowed.
- One of these literal paths, without a trailing slash or encoded/normalized alternatives:

  ```text
  /powerautomate/automations/direct/workflows/<opaqueID>/triggers/manual/paths/invoke
  /powerautomate/automations/direct/cu/<opaqueRoute>/workflows/<opaqueID>/triggers/manual/paths/invoke
  ```

  Each `opaqueID` and `opaqueRoute` must match `[A-Za-z0-9_-]{1,256}`. This is a local safety policy, not a universal Microsoft ID or routing grammar.
- Exactly four query keys, each present once: literal `api-version=1`, `sp` decoded to `/triggers/manual/run`, literal `sv=1.0`, and `sig` with a nonempty decoded value in the base64/base64url alphabet (`A–Z`, `a–z`, digits, `+`, `/`, `_`, `-`) and at most two trailing `=` padding characters. Query order may vary. Values use percent decoding, not form decoding: `+` remains `+`, not a space. Encoded key names, duplicate keys, unknown keys, and malformed percent escapes or UTF-8 are rejected. The original signed URL is preserved, including escape case, query order, and explicit `:443`; it is not rebuilt from decoded values.

Whitespace, controls, backslashes, URL user information, fragments, other ports, malformed encoding, and alternatives that require case or path normalization are rejected. Legacy Office connectors, obsolete `logic.azure.com` endpoints, government clouds, and tenant-authenticated triggers are unsupported. If a current generated URL falls outside this policy, do not edit or reconstruct its signature to make it fit.

The request contains a fixed Adaptive Card 1.2 message attachment. `RichTextBlock`/`TextRun` elements carry sanitized title and metadata as literal text; `TextRun` does not support Markdown. No actions, images, user templates, or routing overrides are included. Terminal controls are removed. Provider-neutral metadata replaces `@` with `＠`; no mention entities are sent. Client automatic links are not guaranteed to be suppressed. The workflow selects the destination chat/channel, whose members can read the metadata.

The entire encoded JSON request is capped locally at 24,000 UTF-8 bytes, including its envelope and JSON escaping. Clipping preserves complete Unicode code points and includes an ellipsis within the budget. This conservative local bound is not proof that every downstream Teams action accepts the rendered card: Microsoft's approximate 28 KB action limit includes rendered elements.

Delivery reuses the bounded JSON transport unchanged: one attempt, no retry, redirects rejected, a 10-second total request/response deadline, and a 65,536-byte response-read cap. **Only HTTP 202** counts as trigger acceptance after that read completes. A bounded empty, text, or JSON body is allowed; no response-body meaning is inferred. Other 2xx statuses are not accepted. Oversized or stalled 202 bodies can still fail with `response` or `timeout`. HTTP 429 reports a safe `rate-limit` and an available positive integer `Retry-After`, without retrying. Under [HTTP 202 semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-202-accepted), acceptance does not establish completed processing. It proves neither that a workflow posted to Teams nor that a recipient read the message; check run history and the receiving chat/channel separately.

Add this fragment to the existing User document and include `teams-workflow` in `targetIds` to select it. Replace the placeholder with the exact current generated URL outside Pi chat; preserve unrelated destinations and settings.

```json
{
  "destinations": {
    "teams-workflow": {
      "provider": "teams",
      "label": "Build Teams workflow",
      "webhookUrl": "<current-generated-workflow-url>"
    }
  }
}
```

No extension OAuth flow, inbound server, SDK, or channel override is needed or supported. See [Teams setup and revocation](#teams-setup-and-revocation) for workflow ownership, permissions, and operational checks.

### Mixed User settings example

Replace placeholders with real values. `appToken` and `userKey` must meet the Pushover length rule; the Discord URL must be copied from Discord. This fragment does not replace existing Telegram, Gotify, Slack, or unknown settings. Omit optional tokens when using anonymous delivery.

```json
{
  "targetIds": ["ntfy", "pushover", "discord", "bark", "home-hook"],
  "destinations": {
    "ntfy": {
      "provider": "ntfy",
      "label": "Personal ntfy",
      "serverUrl": "https://ntfy.sh",
      "topic": "replace-with-your-topic",
      "accessToken": "<access-token>",
      "priority": 3
    },
    "pushover": {
      "provider": "pushover",
      "label": "Personal Pushover",
      "appToken": "<30-character-application-token>",
      "userKey": "<30-character-user-key>"
    },
    "discord": {
      "provider": "discord",
      "label": "Build channel",
      "webhookUrl": "https://discord.com/api/webhooks/<id>/<token>"
    },
    "bark": {
      "provider": "bark",
      "label": "Personal Bark",
      "serverUrl": "https://api.day.app",
      "deviceKey": "<device-key>"
    },
    "home-hook": {
      "provider": "webhook",
      "label": "Home automation",
      "webhookUrl": "https://automation.example.com/pi-notify",
      "bearerToken": "<bearer-token>"
    }
  }
}
```

## Provider setup and revocation

Use `/notify` to add a destination, complete its review, and choose Save only or Save and use. Labels are generated automatically and can be changed. Secret inputs are masked; complete Discord, Teams, and Generic webhook URLs remain hidden in lists, reviews, tests, Status, and errors. Optional ntfy tokens and priority, and Generic tokens, can be cleared in review. Send test previews the metadata and requires confirmation before an external request. Unsaved cancellation does not save a draft; cancelling delivery cannot recall an accepted message.

### Telegram and Gotify

For Telegram, create a bot with [BotFather](https://t.me/BotFather), then start a private conversation with it. After sending a message, obtain the numeric chat ID through the [Bot API](https://core.telegram.org/bots/api#getupdates). Stop other update consumers first; an active webhook prevents `getUpdates` from working. For groups, add the bot and permit it to send messages. Enter the bot token in the masked input, then the chat ID. Set an optional forum topic in review. Revoke an exposed token through BotFather before replacing it.

For Gotify, create an application in the server's Apps tab. Enter its application token in the masked input and the server base URL, including any reverse-proxy path, not `/message`. Review the optional priority. See [Gotify setup](https://gotify.net/docs/pushmsg). Revoke an exposed application token through the server and replace it in User settings.

### ntfy, Pushover, Discord, Bark, and Generic webhook

1. For ntfy, subscribe to a topic with your client and configure server authentication and topic ACLs before sending private metadata. Use `https://ntfy.sh` or your own server base. Add the topic, then review the server, optional access token, and optional priority. Revoke exposed tokens in the ntfy account/server and replace them; changing a public topic name does not establish access control.
2. For Pushover, register an application in your [Pushover account](https://pushover.net/), obtain its application/API token and your user key, and enter both in the masked inputs. Revoke or reset exposed credentials through Pushover account/application management before replacing them; remove an application if required to invalidate its token.
3. For Discord, create a webhook for a normal text channel through channel or server integration settings, then paste the complete webhook URL into the masked input. Channel/server permissions can restrict creation. Delete a compromised webhook in Discord and create a replacement; changing a label does not change its channel or revoke its URL.
4. For Bark, install/register the Bark client, copy its device key, and use `https://api.day.app` or your self-hosted server base. Enter the device key in the masked input. Reset or re-register the device key through the client/server if exposed; verify that the old key no longer works before relying on the replacement.
5. For a Generic webhook, provision a trusted receiver for the fixed payload and, if required, a Bearer token. Enter the complete endpoint URL and optional token in masked inputs. Revoke/rotate the token at the receiver, or disable/replace a secret endpoint URL if exposed.

Keep secrets out of Project files, source control, and Pi chat. Prefer HTTPS and confirm replacements with Send test. Removing or editing a destination does not revoke its old credential. JavaScript memory is not secure credential storage. See the separate [Slack workflow](#slack-setup-and-revocation) for Slack installation and revocation.

## Slack setup and revocation

1. Create or open an app in [Slack app management](https://api.slack.com/apps) for the commercial workspace that must receive notifications. Workspace policy can require administrator approval.
2. Enable Incoming Webhooks, choose Add New Webhook to Workspace, select the destination channel, and authorize it. You must belong to a private channel before selecting it. Copy the generated webhook URL; it is specific to that installation and channel.
3. Run `/notify`, add a Slack destination, and paste the complete URL into the masked input. Review the generated `Slack notifications` label or change it. Reviews show only that the webhook is configured, not its URL or path.
4. Choose Save only to store without selecting, or Save and use to add the destination to User selections atomically. Existing Off settings and explicit Project selections remain unchanged. Send test shows a metadata preview and requires confirmation before one external request. Closing an unsaved draft does not save it.

To change channels, authorize a webhook for the new channel and replace the saved webhook through the destination review, or create a separate destination. The extension cannot override the installed channel, username, or icon. It does not send replies, upload files, or manage Slack apps.

Treat an exposed URL as a compromised credential. Revoke or remove that webhook through Slack app management before replacing it in User settings; ask the workspace administrator if you cannot manage the installation. Slack can also revoke leaked webhooks automatically. Merely editing or removing a destination does not revoke the old webhook. Confirm a replacement with Send test. A disabled webhook, archived channel, or workspace restriction can prevent delivery; repair the installation instead of expecting a retry. Cancelling a request cannot recall a message Slack has already accepted.

## LINE setup and revocation

1. Create a [LINE Official Account](https://developers.line.biz/en/docs/messaging-api/getting-started/) and enable Messaging API from its administration interface. Open the linked channel in LINE Developers Console and obtain a channel access token. Account policy, plan, and region can restrict availability or message allowance.
2. For personal delivery, add the account as a friend and use your developer-console user ID for the same provider. For groups or rooms, permit the account to join and obtain the full `groupId` or `roomId` from an authorized webhook event through an existing receiver. See [user ID discovery](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/) and [group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/). The extension does not install a receiver or discover IDs. A display name or public LINE ID is not the recipient ID.
3. Run `/notify`, add a LINE destination, and enter the token and recipient ID in separate masked inputs. Review the generated label. Replace either private value from review; replacement inputs start empty and never display the saved value. Cancellation leaves the draft unsaved.
4. Choose Save only or Save and use, then Send test. Check the metadata preview before confirming the external request, and check the receiving LINE chat after acceptance. Confirm account allowance and recipient eligibility before expecting automatic delivery.

For exposed credentials, follow the [channel token rules](https://developers.line.biz/en/docs/basics/channel-access-token/) for that token type: revoke a revocable token and replace it, or reissue a long-lived token and end any old-token grace period. Stateless tokens cannot be revoked and expire after their short validity period. Do not rely on removing a destination to revoke a token. Recheck receipt after replacement; cancellation cannot recall an accepted push. Recipient IDs are private identifiers, not authentication credentials; do not publish them with example settings.

## Teams setup and revocation

1. Open Workflows in Teams or Power Automate and create a flow with **When a Teams webhook request is received**. Choose **Anyone** authentication, not a tenant/user-authenticated mode. Configure the downstream Teams action and its target chat/channel for the fixed Adaptive Card. See [Workflows webhook setup](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook); use its Workflows instructions, not legacy Office connector instructions.
2. Confirm Workflows is available under the account, tenant policy, and applicable licensing. The workflow owner's connection and chat/channel posting privileges must permit the downstream action. Add appropriate co-owners and maintain its connections so an owner leaving does not leave an unmanaged flow. The extension cannot grant channel access, repair credentials, or change tenant policy.
3. Save the workflow and copy its current generated URL from the trigger. Use the [trigger URL migration guidance](https://learn.microsoft.com/en-us/power-automate/triggers-troubleshoot) if a URL changed; do not use an obsolete `logic.azure.com` URL or convert it by hand. Compare it with the [supported local URL policy](#microsoft-teams).
4. Run `/notify`, add a Microsoft Teams destination, and paste the complete URL into the masked input. Review the label and choose Save only or Save and use. Replacing the URL uses an empty masked input; the stored value is not displayed. Unsaved cancellation keeps the saved destination unchanged.
5. Use Send test, review the metadata, and confirm one external request. HTTP 202 reports trigger acceptance only. Check workflow run history, downstream action success, and the target chat/channel for the card. A local accepted result does not verify routing, account permissions, or receipt. The current integration remains unverified live; this is a user verification procedure, not a completed smoke result.

Anyone authentication makes URL secrecy essential. If it is exposed, disable the owning workflow to stop use, then revoke/replace the endpoint through the workflow's available controls or delete and recreate the workflow. Ensure the old endpoint is no longer usable before relying on a replacement; ask a workflow owner or administrator if needed. Copy the new generated URL into User settings and confirm its downstream result with Send test. Removing a destination or changing its label does not revoke the old URL. A cancelled HTTP request cannot recall an accepted trigger or Teams post.

## Persistence and recovery

Settings operations are ordered within the process, including across store instances for the same user path. Reads wait for pending writes. This is not a cross-process lock: simultaneous menu edits in different Pi processes can conflict.

Writes read the latest valid document, preserve unrelated fields and destination fields, and publish using a same-directory temporary file plus rename. User settings writes use private `0600` permissions on POSIX, including replacement files. Unknown provider data is retained during unrelated edits. Malformed JSON blocks writes instead of being overwritten with defaults. An existing non-object `destinations` value blocks destination changes. A non-object destination entry cannot be replaced with a new object. Repair these stored structures first; destination setup does not coerce them to empty defaults. A failed save keeps the previous file and effective state; the menu restores the previous displayed setting. A failed operation does not poison subsequent operations. Reload and shutdown await queued settings operations.

If a file is malformed, repair it manually before saving. Disable notifications in every effective scope to stop new attempts and cancel pending reminders. Unloading the extension aborts owned delivery work, but cannot recall accepted messages. Revoke exposed tokens or Slack webhooks before replacing them in User settings.

### Reverting to a version without Teams

While the Teams-capable version is installed, remove Teams IDs from explicit Project selections in every affected project, then remove them from User selections and delete every saved Teams destination, including unselected ones. Confirm all remaining destinations and effective selections are supported before installing the older version and reloading. Unsupported saved destinations disable older routing even when unselected. Existing providers need no migration. Revoke exposed or unused workflow URLs separately through the owning workflow; removing settings does not revoke them.

### Reverting to a version without LINE

While this version is installed, remove LINE destination IDs from explicit Project selections in every affected project, then remove them from User selections and delete all saved LINE destinations, including unselected ones. Preserve the other supported providers and unrelated fields. Confirm the older version supports every saved destination and selected ID before installing it and reloading. Removing selections alone is insufficient: an unsupported unselected destination also disables older routing. Revoke unused or exposed channel tokens separately through LINE.

### Reverting to a version without the new providers

1. While the new build is still installed, remove the IDs of destinations whose provider is `ntfy`, `pushover`, `discord`, `bark`, or `webhook` from explicit Project selections in every affected project. Clear those overrides or select destinations the older version supports; Project arrays replace User selections.
2. Remove those IDs from User selections and remove every saved destination with one of these five provider IDs, including unselected destinations. Removal clears User selection atomically, but the current trusted Project must not explicitly select the destination.
3. Preserve existing Telegram, Gotify, Slack, and unknown fields. Confirm all saved destinations and effective selections are supported by the older version, then install it and reload.

Selections alone are insufficient: unsupported saved destinations disable routing even when unselected. No migration is needed for existing destinations. Revoke discarded credentials at each service separately; removing JSON does not revoke them. If the older version also lacks Slack, follow the Slack steps below.

### Reverting to a version without Slack

1. While the Slack-capable version is installed, remove Slack IDs from explicit Project selections in every affected project. Clear those overrides or select supported Telegram/Gotify IDs. Project arrays replace User selections.
2. Remove Slack IDs from User selections and remove the Slack destinations. Removing a destination also clears its User selection, but is blocked while the current trusted Project explicitly selects it.
3. Confirm that effective selections contain only supported destinations, then install the older version and reload.

Removing selections alone is not enough: older versions disable automatic delivery for any unsupported destination, even an unselected one. There is no migration for existing Telegram or Gotify destinations. Revoke webhooks in Slack separately if they are no longer needed.

## Inactivity timing

The activity baseline starts when the session and input observer start. It measures only input forwarded by Pi through `ctx.ui.onTerminalInput()`. Keyboard input and paste count when they reach this hook. Clicks, wheel events, and focus-gain reports also count if forwarded. Key releases, mouse motion, terminal capability replies, and focus loss do not. Unknown terminal reports are ignored; unsupported terminal keyboard encodings may therefore not count as activity.

In fullscreen mode, Pi registers its viewport listener before extension listeners. It consumes focus events, mouse events, and viewport/search keys. Wheel events can also be consumed, although a focused overlay can cause Pi to forward them. Thus returning to the window, clicking, scrolling, or using a viewport key does not reliably cancel a reminder. In regular mode, more of these events can reach the hook, but delivery still depends on earlier listeners and terminal support. The public API has no observer priority or pre-consumption hook. The extension does not read raw stdin or reorder host listeners.

For a 30-second threshold, settlement after 10 seconds without input waits another 20 seconds. Settlement after 40 seconds without input starts delivery immediately. The timestamp in the message remains the settlement time.

Observed input during the wait cancels that reminder rather than restarting its timer. New work also cancels the pending reminder; the next settlement is evaluated separately. Settings/destination changes cancel pending reminders and apply to subsequent work periods. The duration row is inactive in immediate mode. Focus reporting is optional and never enabled by the extension. A continuously focused window does not suppress reminders.

RPC, print, and JSON use immediate settlement delivery because their client activity is not observable through terminal input. This fallback does not guarantee delivery before a short-lived process exits.

## Work periods and delivery

The coordinator observes `before_agent_start`, with `agent_start` as a fallback, and sends only at `agent_settled`. Low-level retries and continuations preserve the initial work-period start time. The final assistant stop reason identifies a terminal error without forwarding its body. An aborted settlement always suppresses notification, even if an earlier assistant error remains. Load/reload never replays past results.

Metadata is collected at settlement through bounded Git subprocesses. Missing Git information is omitted. Pending metadata work is cancelled with its reminder. Once a delivery attempt starts, new user work does not cancel it; session replacement, reload, shutdown, or explicit test cancellation does. Late results cannot replace newer per-destination status. Test delivery bypasses automatic enablement and inactivity, requires explicit confirmation, and never changes automatic arming or history.

The provider contract validates destinations and sends a provider-neutral notification with a cancellation signal. Providers do not read sessions, change settings, schedule timers, or decide notification policy. The built-in provider map contains Telegram, Gotify, Slack, ntfy, Pushover, Discord, Bark, Generic webhook, LINE, and Microsoft Teams. Transport results distinguish accepted, failed with a safe code, and cancelled; retry-after is diagnostic, not an automatic retry instruction.

All transports reject redirects, use a 10-second deadline covering the request and response read, make one attempt, and cap success response reads at 65,536 bytes. Errors expose only fixed codes, never tokens, request URLs, response bodies, or raw transport exceptions. ntfy, Pushover, Discord, Bark, Generic webhook, LINE, and Teams report HTTP 429 as `rate-limit`, with a positive integer `Retry-After` in seconds when available; fractional Discord retry values are not displayed. Retry-after is diagnostic only. Service acceptance does not prove device receipt, downstream delivery, or reading. Text clipping preserves Unicode code points; the [provider limits](#new-provider-fields) specify each byte or UTF-16 budget.

Telegram requests use its fixed HTTPS origin and do not enable paid broadcasts. Text is clipped to at most 4096 UTF-16 code units without splitting a Unicode code point. Telegram's JSON `ok` field and HTTP status are both checked.

Gotify posts JSON to `<serverUrl>/message` with `X-Gotify-Key` application-token authentication. The title and body are separate fields; emphasis metadata is not sent, and Markdown extras are not enabled. An unset priority is omitted so the server uses the application's default. A successful HTTP response must contain a message with positive integer `id` and `appid`, string `message`, and valid `date`. HTTP failures use a safe `http` code; HTTP 429 uses `rate-limit` and includes a positive integer `Retry-After` value when available. Server response text is never displayed.

Slack posts JSON to the validated webhook URL. It sends only the same provider-neutral title and metadata body as the other providers: hostname, session name/ID, working directory, available Git repository/worktree/branch, elapsed time, and settlement timestamp. Paths can disclose private information even when the home prefix is shortened. The selected channel's members can read this metadata. Prompts, assistant answers, code, tool output, Git remotes, credentials, and raw errors are not included.

Slack combines the title and body into one section block with a `plain_text` text object and `emoji: false`, not dynamic `mrkdwn`. Slack control characters `&`, `<`, and `>` are entity-escaped once so existing entity-like metadata also displays literally. The encoded text is capped at 3000 UTF-16 code units without splitting Unicode code points or entities; longer messages end with an ellipsis. Dynamic terminal controls are removed and metadata remains literal; mention and link expansion are disabled. The top-level fallback is the fixed text `Pi notification. Open Pi to review.` with markup and unfurling disabled. Screen readers and notification surfaces that use this fallback receive a generic reminder. Slack desktop notifications can extract block text instead, so metadata can still appear outside the channel view. Only HTTP 200 with the documented plain-text `ok` response counts as accepted; malformed or oversized success responses fail safely. HTTP 429 reports `rate-limit` with a valid positive integer `Retry-After` when available, without retrying. Other HTTP failures and invalid responses use fixed safe codes; response bodies and transport exceptions are never shown. Slack generally permits one webhook message per second, with short bursts; multiple destinations or rapid work periods can exceed workspace/channel limits. There is no automatic retry, queue, cooldown, or replay after reload. Accepted does not mean read.

## Authoritative references

- [Telegram BotFather setup](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
- [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage): chat IDs, forum topics, text limits, and link previews.
- [Telegram getUpdates](https://core.telegram.org/bots/api#getupdates): manual chat-ID discovery; incompatible with active webhooks.
- [Telegram ResponseParameters](https://core.telegram.org/bots/api#responseparameters): `retry_after` on flood control.
- [Telegram rate limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this): avoid more than one message per second in a chat, 20 per minute in a group, and about 30 per second across free broadcasts.
- [Gotify push messages](https://gotify.net/docs/pushmsg): application setup and application-token authentication.
- [Gotify API](https://gotify.net/api-docs) and [server API specification](https://raw.githubusercontent.com/gotify/server/v3.1.1/docs/spec.json): `POST /message`, message fields, and response schema.
- [Slack Incoming Webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/): setup, commercial URL shape, fixed channel, secret handling, HTTP 200 `ok`, and failure conditions.
- [Slack text objects](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/) and [section blocks](https://docs.slack.dev/reference/block-kit/blocks/section-block/): `plain_text` and the 3000-character text limit.
- [Slack message formatting](https://docs.slack.dev/messaging/formatting-message-text/#escaping): escaping control characters and disabling markup with `plain_text` and `mrkdwn: false`; desktop notifications can extract block text, while mobile notifications use top-level text.
- [Slack message posting](https://docs.slack.dev/reference/methods/chat.postMessage/): notification/screen-reader fallback text, parsing, link unfurling, and text limits; Incoming Webhooks follow Slack's messaging format.
- [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/): Incoming Webhooks, HTTP 429, and `Retry-After` seconds.
- [ntfy publishing](https://docs.ntfy.sh/publish/): JSON publishing, topic names, priority, and size limits; [access control](https://docs.ntfy.sh/config/#access-control): authentication, topic permissions, and access tokens.
- [Pushover Messages API](https://pushover.net/api): fixed endpoint, application/user credentials, normal priority, message limits, and numeric status responses.
- [Discord Execute Webhook](https://discord.com/developers/docs/resources/webhook#execute-webhook): endpoint, `wait=true`, content limits, Message response, and flags; [allowed mentions](https://discord.com/developers/docs/resources/message#allowed-mentions-object): explicit empty mention parsing.
- [Bark tutorial](https://bark.day.app/#/tutorial) and official server source at commit `640deaa151ddf79193202927b35ca2f14f65ee1d`: [JSON API](https://github.com/Finb/bark-server/blob/640deaa151ddf79193202927b35ca2f14f65ee1d/docs/API_V2.md), [push handler](https://github.com/Finb/bark-server/blob/640deaa151ddf79193202927b35ca2f14f65ee1d/route_push.go), [router](https://github.com/Finb/bark-server/blob/640deaa151ddf79193202927b35ca2f14f65ee1d/router.go), and [Basic authentication](https://github.com/Finb/bark-server/blob/640deaa151ddf79193202927b35ca2f14f65ee1d/route_auth.go). These establish `/push`, `device_key`, numeric acceptance, body logging, and the unsupported native Basic-auth mode.
- [Apple APNs payloads](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification): the 4096-byte regular notification payload limit; Bark's smaller local text budgets leave envelope space.
- [LINE push messages](https://developers.line.biz/en/reference/messaging-api/#send-push-message) and [text character count](https://developers.line.biz/en/docs/messaging-api/text-character-count/): fixed endpoint, eligibility, UTF-16 budget, and response conditions.
- [LINE OpenAPI](https://github.com/line/line-openapi/blob/main/messaging-api.yml) and [official SDK push tests](https://github.com/line/line-bot-sdk-nodejs/blob/master/test/line-bot-client.spec.ts): current `sentMessages` and legacy empty-object acceptance.
- [LINE channel access tokens](https://developers.line.biz/en/docs/basics/channel-access-token/), [user IDs](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/), [group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/), and [pricing](https://developers.line.biz/en/docs/messaging-api/pricing/): setup, revocation, recipient acquisition, and account-dependent message allowance.
- [Teams connector: Microsoft Teams Webhook](https://learn.microsoft.com/en-us/connectors/teams/#microsoft-teams-webhook): trigger authentication and card envelope; Anyone requests omit Authorization. This does not establish a complete URL or HTTP response contract.
- [Teams Workflows webhook setup](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook) and [trigger troubleshooting/URL migration](https://learn.microsoft.com/en-us/power-automate/triggers-troubleshoot): workflow creation, ownership, and current generated URLs. Published examples inform the supported client policy; they are not a normative universal URL grammar.
- [Adaptive Cards TextRun schema](https://learn.microsoft.com/en-us/adaptive-cards/schema-explorer/text-run) and [RichTextBlock schema](https://learn.microsoft.com/en-us/adaptive-cards/schema-explorer/rich-text-block): literal text without Markdown in TextRun.
- [RFC 9110: 202 Accepted](https://www.rfc-editor.org/rfc/rfc9110.html#name-202-accepted): acceptance is not completed processing; it does not establish which status every Teams workflow returns.
- [Pi extension lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#agent_start--agent_end--agent_before_settle--agent_settled).

Input classification follows the installed Pi `ProcessTerminal` and `StdinBuffer` sequence splitting, Pi's `parseKey`/`isKeyRelease`, and `TuiAltScreen` SGR mouse handling. Pure classifier tests cover keyboard, Unicode, paste, focus, press/release, motion, wheel, legacy mouse, CSI/OSC/DCS/APC replies, and unknown input. These tests do not prove that an event reaches the extension. Installed-runtime tests also pass events through real regular/fullscreen Pi renderers and check listener order, viewport keys, and focused-overlay branches. Physical terminal and multiplexer behavior remains unverified.
