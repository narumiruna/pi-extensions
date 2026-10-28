# @narumitw/pi-notify

## 0.4.1

### Patch Changes

- 57cf529: Prebuild the package-owned TypeScript into a split Jiti runtime to reduce package loading work while preserving lazy menu loading and notification behavior. Local package-directory loading now requires a build; published packages include the generated runtime.

## 0.4.0

### Minor Changes

- 515841d: Add LINE Messaging API destinations with masked token and recipient setup, confirmed tests, Unicode-safe text limits, and bounded one-attempt delivery. Preserve private User settings and existing provider behavior.
- bf9de4f: Add Microsoft Teams Workflows destinations with masked signed-URL setup, confirmed tests, literal Adaptive Card text, a local encoded-payload budget, and bounded one-attempt delivery. Support commercial Anyone-authenticated triggers under an explicit local URL policy; only HTTP 202 counts as trigger acceptance, not a Teams post or receipt. Live interoperability remains unverified. Preserve private User settings and existing provider behavior.

## 0.3.0

### Minor Changes

- 57a285f: Add Gotify destinations with application-token authentication, server URLs, optional priority, masked setup, and confirmed test delivery alongside Telegram.
- 2442572: Add ntfy, Pushover, Discord webhook, Bark, and Generic webhook destinations with masked setup, confirmed tests, and bounded one-attempt delivery. Keep credentials in private User settings and preserve existing Telegram, Gotify, and Slack behavior.
- 11949a2: Add Slack Incoming Webhook destinations alongside Telegram and Gotify. Configure and test fixed-channel Slack notifications through `/notify`, with User-only webhook secrets, redacted reviews, plain-text metadata, bounded delivery, and no automatic retries. Existing destinations and notification timing are unchanged.

### Patch Changes

- 49abb15: Use bold Telegram titles and repository names, with inline monospace branches, paths, and session IDs. Preserve literal punctuation, plain-text confirmation previews, and notification timing.

## 0.2.0

### Minor Changes

- 2d53961: Add Telegram settlement notifications, a provider delivery boundary, and a menu with inactivity reminders and private settings.

### Patch Changes

- c79a679: Require only a bot token and chat ID during Telegram setup. Generate labels automatically and keep labels and forum topics editable from review. Offer Save and use or Save only at confirmation, selecting new chats atomically when requested, for User notifications and enable automatic notifications by default, preserving explicit Off settings and Project selections. Clarify the automatic-notification switch with On/Off values.
