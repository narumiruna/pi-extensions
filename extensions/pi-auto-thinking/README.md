# 🧠 pi-auto-thinking — Automatic Thinking Level for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-auto-thinking)](https://www.npmjs.com/package/@narumitw/pi-auto-thinking) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-auto-thinking` is a native [Pi coding agent](https://pi.dev) extension that selects Pi's thinking level for each user task from the active model capability and a deterministic task-difficulty score.

Use it when you want simple prompts to stay cheap and fast, while design, debugging, migration, security, or refactor tasks automatically get more reasoning budget.

## ✨ Features

- Automatically selects `minimal`, `low`, `medium`, `high`, or `xhigh` before each agent turn.
- Turns thinking `off` for models that do not advertise reasoning support.
- Respects model `thinkingLevelMap` entries that mark levels unsupported.
- Uses conservative defaults: enabled, `minLevel: "minimal"`, `maxLevel: "high"`.
- Avoids extra LLM calls; task difficulty is scored with local deterministic heuristics.
- Detects likely manual thinking-level changes and pauses automation for a few turns.
- Adds `/auto-thinking` commands for status, enable/disable, and explaining the last decision.
- Shows a compact statusline item after decisions without notifying every turn.

## 📦 Install

```bash
pi install npm:@narumitw/pi-auto-thinking
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-auto-thinking
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-auto-thinking
```

## 🚀 Usage

```text
/auto-thinking status
/auto-thinking on
/auto-thinking off
/auto-thinking explain
```

- `status` shows whether automation is enabled, the loaded config path, bounds, and warnings.
- `on` enables automatic thinking selection for subsequent user prompts.
- `off` disables automation and clears the extension statusline item.
- `explain` shows the score, selected level, and matched signals from the last decision.

## 🧮 How scoring works

The extension scores each prompt locally before Pi starts the agent loop. The base level mapping is:

| Score | Base thinking level |
| ---: | --- |
| `<= 0` | `minimal` |
| `1..2` | `low` |
| `3..5` | `medium` |
| `6..8` | `high` |
| `>= 9` | `xhigh` |

Default weights:

| Signal | Weight |
| --- | ---: |
| Quick, brief, concise, simple, or equivalent Chinese wording | `-2` |
| Simple explanation, translation, or summary | `-1` |
| Implementation, editing, or code-change request | `+2` |
| Debugging, exception, stack trace, failure, or broken behavior | `+2` |
| Tests, lint, typecheck, TypeScript, CI, or similar | `+1` |
| Design, architecture, plan, proposal, or tradeoff work | `+3` |
| Migration, refactor, compatibility, or breaking-change work | `+3` |
| Security, auth, secrets, concurrency, transaction, rollback, or data-loss topic | `+3` |
| Explicit deep reasoning request such as “think hard”, “carefully”, “深入”, or “仔細” | `+3` |
| Code block included | `+1` |
| One file path mentioned | `+1` |
| Three or more file paths mentioned | `+2` |
| Long prompt | `+1` |
| Image input attached | `+1` |

After scoring, config bounds and model support are applied. For example, with the default `maxLevel: "high"`, a score that maps to `xhigh` is capped at `high`.

## ⚙️ Configuration

Optional config file:

```text
$PI_CODING_AGENT_DIR/pi-auto-thinking.json
```

When `PI_CODING_AGENT_DIR` is unset, the extension reads:

```text
~/.pi/agent/pi-auto-thinking.json
```

Example:

```json
{
  "enabled": true,
  "minLevel": "minimal",
  "maxLevel": "high",
  "respectManualTurns": 3,
  "modelOverrides": {
    "anthropic/claude-haiku-4-5": {
      "maxLevel": "medium"
    },
    "anthropic/claude-opus-4-5": {
      "maxLevel": "xhigh"
    },
    "local/small-fast-model": {
      "enabled": false
    }
  }
}
```

Supported levels are:

```text
off, minimal, low, medium, high, xhigh
```

`respectManualTurns` must be an integer from `0` to `20`. When a thinking level changes outside this extension, automation pauses for that many future user prompts. Pi's event does not expose the change source, so this detection is intentionally conservative.

## 🤖 Model capability behavior

- If `ctx.model` is unavailable, the extension selects `off`.
- If `ctx.model.reasoning` is false, the extension selects `off`.
- If `ctx.model.thinkingLevelMap` marks a level as `null`, the extension skips that level.
- Pi still performs its own final clamp when `pi.setThinkingLevel()` is called.

## 💸 Cost and latency caveats

Higher thinking levels can increase latency and token usage depending on the provider. The default maximum is `high`, not `xhigh`, to avoid unexpectedly expensive turns. Use `/auto-thinking explain` to inspect why a level was selected, or `/auto-thinking off` to disable automation for the session.

## 🗂️ Package layout

```txt
extensions/pi-auto-thinking/
├── src/
│   └── auto-thinking.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/auto-thinking.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, automatic thinking, reasoning level, task difficulty, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
