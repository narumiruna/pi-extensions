# 📨 pi-telegram-bot — Telegram Bot Chat for Pi Sessions

[![npm](https://img.shields.io/npm/v/@narumitw/pi-telegram-bot)](https://www.npmjs.com/package/@narumitw/pi-telegram-bot) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> Deprecated: this package is kept for reference under `deprecated/` and is no longer part of the active workspace package set.

`@narumitw/pi-telegram-bot` is a native [Pi coding agent](https://pi.dev) extension that lets a Telegram Bot talk to one currently running Pi session.

Use it to message your active Pi session remotely, ask which session/project/model you are talking to, and request code changes through that session's existing Pi tools.

## ✨ Features

- Stays disabled by default until you opt in from Pi with `/telegram-bot` or `/telegram-bot enable`.
- Connects Telegram text messages to the current Pi session with `pi.sendUserMessage()`.
- Sends the assistant's final reply back to Telegram after the Pi turn completes.
- Shows the current session name, session file, project cwd, and model from `/status`.
- Supports Telegram `/start`, `/help`, `/status`, `/whoami`, and `/cancel` commands.
- Adds Pi `/telegram-bot` enable/disable/status/help and `/telegram-bot send <text>` commands.
- Loads bot credentials from the user-scoped JSON config at `~/.pi/agent/telegram.json`.
- Ignores messages from any Telegram chat other than the configured `chatId`.
- Registers no custom Pi tools.

## 📦 Install

```bash
pi install npm:@narumitw/pi-telegram-bot
```

Try without installing permanently after creating the config file:

```bash
pi -e npm:@narumitw/pi-telegram-bot
```

Try this package locally from the repository root:

```bash
pi -e ./deprecated/pi-telegram-bot
```

## ⚙️ Configuration

Create a JSON config file. The safest default is the user-scoped Pi config:

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/telegram.json <<'JSON'
{
  "botToken": "123456:bot-token-from-botfather",
  "chatId": "123456789"
}
JSON
```

The extension only reads `~/.pi/agent/telegram.json`. It intentionally ignores project-local `.pi/telegram.json` files so a repository cannot override your Telegram bot destination.

Config shape:

```json
{
  "botToken": "123456:bot-token-from-botfather",
  "chatId": "123456789"
}
```

Aliases are accepted for convenience: `token` or `telegramBotToken` for `botToken`, and `chat_id` or `telegramChatId` for `chatId`.

The single configured `chatId` is both the allowed inbound chat and the outbound target chat.

When enabled, if `botToken` is set but `chatId` is missing or blank, the extension starts in setup mode. In setup mode, anyone who can message the bot can use only `/start`, `/help`, and `/whoami` to discover their Telegram chat id. Normal messages are not forwarded to Pi, and `/cancel` does not work until `chatId` is configured.

Do not commit Telegram bot tokens or chat IDs to a repository. Keep this file in your user-scoped Pi config directory. On Unix-like systems, the file must not be group- or world-readable; run `chmod 600 ~/.pi/agent/telegram.json` if needed.

## 💬 Telegram usage

First enable polling from Pi with `/telegram-bot` or `/telegram-bot enable`; polling is disabled by default each time a Pi session starts.

Then send any normal text message to the bot. The extension forwards it to the current Pi session, so the agent can answer or modify code if the current session has the needed tools active.

Messages sent while Pi is already working are queued as steering messages for the current turn, so they can affect the ongoing task before Pi starts another model call. The temporary busy acknowledgement is edited into the final assistant reply when the turn finishes.

Telegram commands:

```text
/start   show help
/help    show help
/status  show current Pi session identity
/whoami  show Telegram chat/user identity
/cancel  request abort for the current Pi turn
```

`pi-telegram-bot` intentionally controls only the Pi process currently running this extension. It does not switch to saved sessions or route messages across other Pi processes.

Use `/status` to show the current Pi session identity:

```text
🤖 Pi Telegram session
Name: Refactor auth module
Session: ~/.pi/agent/sessions/...jsonl
Project: ~/workspace/my-project
Model: anthropic/claude-sonnet-4-5
```

Normal assistant replies omit this header to keep Telegram chat output concise.

## 🧑‍💻 Pi commands

```text
/telegram-bot
/telegram-bot enable
/telegram-bot disable
/telegram-bot status
/telegram-bot help
/telegram-bot send <text>
```

`/telegram-bot` opens a local enable/disable menu. `/telegram-bot enable` starts Telegram long polling for the current Pi session, and `/telegram-bot disable` stops it.

`/telegram-bot status` shows local configuration, polling status, current session identity, and confirms that the extension registers no custom tools.

`/telegram-bot send <text>` sends a manually-authored message from Pi to the configured Telegram chat.

## 🛠️ No custom tools

This extension intentionally does **not** call `pi.registerTool()` and does not add any `telegram_*` tool.

Telegram messages become normal user messages in the current Pi session. Whether the agent can modify code depends on the session's active tools. For code changes, keep the usual Pi tools such as `edit`, `write`, and/or `bash` enabled.

## 🚧 Limitations

- Telegram polling is opt-in per Pi session and is disabled by default.
- MVP uses Telegram long polling, not webhooks.
- Only Telegram text messages are supported.
- Use one active Pi process per Telegram bot token. Running multiple long-polling Pi sessions with the same bot token can conflict at the Telegram API level. Use separate bot tokens if you need multiple concurrent remote sessions.
- Before `chatId` is configured, `/whoami` setup discovery intentionally responds to any chat that messages the bot; configure `chatId` to lock the bot to one chat.
- Pending Telegram messages that arrived before the extension started are discarded on startup to avoid replaying stale code-changing requests.

## 🗂️ Package layout

```txt
deprecated/pi-telegram-bot/
├── src/
│   └── telegram-bot.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/telegram-bot.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, Telegram bot, remote Pi session, coding agent chat, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
