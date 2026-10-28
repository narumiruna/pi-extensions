# 🔔 pi-notify

[![npm](https://img.shields.io/npm/v/@narumitw/pi-notify)](https://www.npmjs.com/package/@narumitw/pi-notify)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Send reminders through Telegram, Gotify, Slack, ntfy, Pushover, Discord, Bark, LINE, Microsoft Teams Workflows, or a Generic webhook when Pi stops automatic work.

## ✨ Features

- Notify Telegram chats and forum topics, Gotify applications, Slack or Discord channels, ntfy topics, Pushover users, Bark devices, LINE recipients, Teams Workflows, or your own webhook.
- Select multiple destinations across all ten providers.
- Identify the computer, session, repository, branch, and worktree without forwarding conversations.
- Choose immediate notifications or reminders after terminal inactivity.
- Configure and test destinations through a masked, menu-first setup flow.

Telegram uses bold titles and repository names, with inline monospace for branches, paths, and session IDs. Entity-based formatting keeps punctuation literal without Markdown or HTML parsing. Confirmation previews remain plain text.

## 📦 Install

Extensions run with Pi's permissions. Enable this extension only if the notification metadata may leave your computer. Notification tokens, device keys, LINE recipient IDs, and complete Slack, Discord, Teams, and Generic webhook URLs are private values stored in a private User settings file, not Project settings.

From a local checkout, run these commands from the repository root:

```sh
npm install
npm --workspace @narumitw/pi-notify run build
pi -e ./packages/pi-notify
```

After npm publication, persistent and temporary installation will be available with:

```sh
pi install npm:@narumitw/pi-notify
pi -e npm:@narumitw/pi-notify
```

Restart Pi or run `/reload` after persistent installation. Published packages include a generated split `dist/index.ts` runtime for Pi's Jiti loader. Build an unbuilt local checkout before loading the package directory; repository Git/source installation retains `src/index.ts`. The `/notify` menu loads only when opened. The extension requires Pi APIs for `agent_settled`, `getAgentDir()`, and trusted project settings, plus Node.js with native `fetch` and `AbortSignal.any()`.

## 🚀 Quick start

1. Subscribe to a topic in your ntfy client. A topic name is not access control: configure [server authentication and topic permissions](https://docs.ntfy.sh/config/#access-control) before sending private metadata. Public topics can expose messages and permit unwanted publishers.
2. Run `/notify`, open destination management, and add an ntfy destination. Enter the topic. In the review, set your server base URL, an optional access token in the masked input, and an optional priority from 1 to 5. Clear priority to use the server default.
3. Choose Save and use to save and select the destination for User notifications, or Save only to store it without selecting it. Use Send test to preview the metadata and confirm one external request.

Automatic notifications are on by default, so the next eligible settled work period sends a reminder. Settings lets you pause delivery or change selections. Existing Off settings and explicit Project selections are preserved. See [provider setup and revocation](./docs/settings.md#provider-setup-and-revocation) for Telegram, Gotify, ntfy, Pushover, Discord, Bark, and Generic webhook setup.

For Slack, create a [Slack app](https://api.slack.com/apps), enable Incoming Webhooks, and choose Add New Webhook to Workspace. Authorize the channel that must receive notifications and copy its webhook URL. Enter it only in the masked setup input or User settings, never in Pi chat. The installation fixes the channel; a destination cannot override it. See [Slack setup and revocation](./docs/settings.md#slack-setup-and-revocation).

For Microsoft Teams, create a Workflows flow with **When a Teams webhook request is received**, select **Anyone** authentication, and configure its downstream chat/channel action. Paste the current generated URL only into the masked input or User settings. The integration has not been verified live; HTTP 202 means trigger acceptance, not a successful Teams post. Check workflow run history and the receiving chat/channel after a confirmed test. See [Teams setup and revocation](./docs/settings.md#teams-setup-and-revocation).

For LINE, enable Messaging API on a LINE Official Account and obtain a channel access token and eligible user, group, or room ID. `/notify` accepts both in masked inputs. Delivery consumes the account's applicable message allowance; quotas and plans vary by region. LINE Notify is not supported. See [LINE setup and revocation](./docs/settings.md#line-setup-and-revocation).

## 💬 Commands

`/notify` opens destination management, Settings, Status, Help, and confirmed test delivery in TUI mode. It accepts no arguments. Settings changes save immediately; closing the screen does not undo them. Destination edits remain unsaved until confirmation. Escape goes back; Ctrl+C closes the flow. Cancelling a running test closes the menu and cannot recall a message already accepted by the provider.

RPC receives manual configuration instructions instead of a custom terminal screen. Print and JSON reject interactive setup. Automatic delivery is independent of the menu and requires no model tool or prompt changes.

## ⚙️ Settings

User settings are stored at `<getAgentDir()>/pi-notify.json`, normally `~/.pi/agent/pi-notify.json`. Trusted project overrides use `<workspace>/.pi/pi-notify.json`. Choose User or Project scope in `/notify` Settings. Destinations and credentials are always User-scoped.

Notifications default to enabled, with immediate mode and a stored inactivity duration of 30 seconds. Loading defaults does not create a file. Successful menu saves apply immediately; manual edits take effect on session start or `/reload`.

```json
{
  "enabled": true,
  "mode": "after-inactivity",
  "inactivitySeconds": 30,
  "targetIds": ["personal"],
  "destinations": {
    "personal": {
      "provider": "ntfy",
      "label": "Personal ntfy",
      "serverUrl": "https://ntfy.sh",
      "topic": "replace-with-your-topic",
      "accessToken": "<access-token>",
      "priority": 3
    }
  }
}
```

See the bundled [settings and behavior reference](./docs/settings.md) for accepted values, inheritance, persistence, provider boundaries, failure recovery, and inactivity timing.

## 🔒 Security and privacy

Notifications send the operating-system hostname, session name and ID, working directory, available Git repository/worktree/branch, elapsed time, and settlement timestamp to the selected notification services or webhook endpoints. Gotify messages are visible to the user who owns the application; Slack messages are visible to people with access to the installed channel. Paths shorten the home prefix to `~` when possible, but names and paths can still disclose private information. They describe the host running Pi, which can differ from your SSH client computer.

No prompts, assistant answers, code, tool output, Git remotes, or raw provider errors are sent. Dynamic metadata is bounded and terminal controls are removed; `@` is replaced with `＠` to avoid accidental mentions. Telegram link previews are disabled. Gotify sends plain text without Markdown extras. Slack uses `plain_text` blocks without mention or link expansion and a generic fallback. Slack desktop notifications can still show metadata from the blocks. Discord disables mention parsing and link previews, but does not suppress notifications. Credential values, LINE recipient IDs, and complete Slack, Discord, Teams, and Generic webhook URLs never appear in review, preview, status, or error output. LINE receives the selected recipient ID and metadata through its Messaging API; members of a selected group or room can read the message. LINE clients can automatically link URLs in plain text. Teams receives a fixed Adaptive Card with literal text and no actions, images, or mentions; client automatic links are not guaranteed to be suppressed. People with access to the workflow's destination chat/channel can read its metadata. POSIX settings writes use `0600` permissions and temporary-file-plus-rename publication. JavaScript memory is not secure credential storage; revoke exposed tokens through BotFather or your Gotify server, or revoke the webhook in Slack before replacing its User setting. Removing a saved destination does not revoke its credential. See [provider revocation instructions](./docs/settings.md#provider-setup-and-revocation) for the new services.

Gotify sends its application token in the `X-Gotify-Key` header, never in the URL. Use HTTPS: HTTP is supported for private self-hosted servers but sends the token and metadata without encryption. Server URLs cannot contain credentials, query strings, or fragments. Redirects are rejected.

Prefer HTTPS for ntfy, Bark, and Generic webhooks too: HTTP sends credentials and metadata without encryption. User-configured endpoints can reach local/private addresses on the Pi host's network; Project settings cannot supply endpoints. ntfy topic secrecy is not access control, and access tokens have the user's full access. Configure server ACLs. Bark JSON keeps keys and messages out of URLs but does not prevent the official server from logging request bodies. Do not send metadata to servers you do not trust.

## 🚧 Limitations

The ten listed providers are built in; third-party provider plugins are not loaded. Slack supports commercial Incoming Webhooks at `https://hooks.slack.com/services/...` only, with the channel selected during installation. GovSlack, channel overrides, OAuth, bot tokens, replies, and file uploads are not supported. No Slack SDK or extension-specific environment variables are required. Gotify uses application tokens, not client tokens or user passwords. It sends messages only; it does not subscribe to messages or manage applications.

Teams supports commercial Workflows with Anyone authentication only, without an Authorization header. The workflow owns routing; account permissions, workflow owners/co-owners, tenant policy, and Workflows availability affect delivery. Legacy Office connectors, `logic.azure.com`, government clouds, tenant-authenticated triggers, OAuth, and channel overrides are not supported. The fixed Adaptive Card 1.2 uses literal `RichTextBlock`/`TextRun` text without Markdown. Encoded JSON is capped locally at 24,000 UTF-8 bytes, with Unicode-safe clipping; this is not a downstream rendering guarantee. Only HTTP 202 after a bounded response read counts as trigger acceptance. This explicit client policy awaits live interoperability verification, not a claim of a universal Microsoft URL or response contract. See [Teams URL, payload, and acceptance limits](./docs/settings.md#microsoft-teams).

LINE sends one plain-text Messaging API push, clipped to 5,000 UTF-16 code units. It requires an eligible recipient and account allowance; HTTP acceptance does not prove receipt, including when the recipient blocked the account. It does not discover recipient IDs, receive events, manage accounts, or support replies, broadcast, silent delivery, or LINE Notify. See [LINE fields and delivery limits](./docs/settings.md#line).

Pushover uses normal priority only, without emergency delivery, acknowledgement, or retry parameters. Discord supports official webhooks for normal text channels, not forum/media channels or thread selection. ntfy and Generic webhooks support no authentication or Bearer authentication only; Bark supports its device key, not native server Basic authentication. No custom headers, templates, scripts, or extension-specific environment variables are supported. See [provider fields and limits](./docs/settings.md#new-provider-fields) for exact URL, credential, and payload bounds.

Telegram messages are limited to 4,096 UTF-16 code units without splitting a Unicode code point; longer messages end with an unformatted ellipsis. Gotify sends the title and body in separate fields; server and proxy limits apply. Slack clips plain-text blocks to its documented limits without splitting Unicode code points; see the [payload and delivery reference](./docs/settings.md#work-periods-and-delivery).

Inactivity means no input reached this extension, not proof that you are away. Pi handles fullscreen focus, mouse, scrolling, and search before extension input listeners. Those actions do not reliably cancel a reminder. Reading without typing can still produce one. Type a key that reaches the editor to cancel a pending reminder. Focus or mouse events count only if Pi forwards them; terminal support alone is not sufficient. This extension does not change Pi's listener order, enable focus reporting, or detect screen locks. RPC, print, and JSON cannot observe terminal input, so inactivity mode delivers at settlement instead.

Notification delivery is best effort with one attempt and a 10-second deadline covering the request and response body, capped at 65,536 bytes. There is no automatic retry, persistent queue, or replay after reload. Accepted means the provider accepted a message, not that someone read it. Rate limits can reject rapid runs; Status reports a safe error code and available retry-after time. Immediate shutdown can cancel an in-flight notification, especially in a short-lived headless session.

Manual aborts and interactive confirmation prompts do not notify. `agent_settled` means Pi will not continue automatically, not that the requested task succeeded. Preflight errors that do not produce a settled work period cannot generate a completion notification. No cooldown suppresses distinct eligible work periods.

Before reverting to a version without Teams, remove its IDs from every affected explicit Project selection, User selections, and all saved Teams destinations while this version remains installed. Revoke exposed or unused workflow URLs separately. Before reverting to a version without LINE, remove its destination IDs from explicit Project selections, User selections, and saved destinations while this version is installed; unselected unsupported destinations also disable older routing. Revoke credentials through LINE separately. Before reverting to a version without the five new providers, remove their IDs from every affected Project selection, User selections, and saved destinations while the current version is installed. Before reverting to a version without Slack support, remove Slack IDs from User and Project selections and remove the Slack destinations while the current version is installed. Older versions disable automatic delivery for unsupported destinations, even when unselected. See [rollback steps](./docs/settings.md#persistence-and-recovery).

## 🗂️ Package layout

- `dist/index.ts`: generated package entrypoint with split runtime chunks and source maps.
- `src/index.ts`: repository source entrypoint forwarding to `src/notify.ts`.
- `src/`: session coordination, metadata, settings, menu, and provider contract.
- `src/providers/`: provider-specific transports and shared bounded HTTP handling.
- `docs/`: installed settings and behavior reference.
- [benchmarks/](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-notify/benchmarks): repository-only startup measurements and reproduction commands; not published.
- `scripts/`: repository-only runtime builder wrapper.
- `test/`: repository-only deterministic tests.

The package publishes the generated runtime, TypeScript source, documentation, and its license. It does not publish build scripts, test fixtures, or credentials.

## 🔎 Keywords

Pi coding agent, Telegram bot, Gotify, Slack Incoming Webhooks, ntfy, Pushover, Discord webhook, Bark, LINE Messaging API, Microsoft Teams Workflows, Generic webhook, self-hosted notifications, completion notification, inactivity reminder, Git worktree.

## 📄 License

[MIT](./LICENSE).
