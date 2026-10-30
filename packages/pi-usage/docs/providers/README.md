# Provider guides

[Back to package README](../../README.md)

Use these guides for provider-specific setup, credentials, endpoints, reported data, statusline behavior, limitations, and available contract evidence.
A subscription allowance, current balance, and rated spend are not interchangeable. Currencies and billing targets remain separate.

| Provider | Reported data |
| --- | --- |
| [Anthropic (Claude subscription OAuth)](./anthropic.md) | Opt-in extra-usage spend, monthly limit, and remaining allowance |
| [OpenAI (native ChatGPT OAuth)](./openai.md) | Authentication status by default; optional companion-sourced plan percentages and plan/app resets |
| [OpenAI Codex (legacy)](./openai-codex.md) | Subscription windows, credits, resets, model buckets, Fast mode, and reset redemption |
| [Kimi For Coding](./kimi-coding.md) | Plan request windows and a separate booster wallet |
| [Moonshot AI Global/China](./moonshotai.md) | Current API balance in USD/CNY |
| [MiniMax Global/China](./minimax.md) | Token Plan windows or pay-as-you-go API balance |
| [GitHub Copilot](./github-copilot.md) | AI credits, premium requests, or Free-plan chat allowance |
| [OpenRouter](./openrouter.md) | Per-key credit limits and spending windows |
| [DeepSeek](./deepseek.md) | Exact current CNY and USD API balances |
| [Fireworks](./fireworks.md) | Rated trailing 30-day spend for one selected account |
| [Vercel AI Gateway](./vercel-ai-gateway.md) | Team credit balance and lifetime spend |
| [Baseten](./baseten.md) | Organization-wide trailing 30-day Model APIs spend after credits |
| [OpenCode Go](./opencode-go.md) | Rolling, weekly, and monthly plan windows |
| [Command Code](./command-code.md) | Billing-period plan credits and rolling 5-hour/weekly spending caps |
| [xAI](./xai.md) | OAuth subscription allowance and credits; explicit menu queries only |
| [Z.AI](./zai.md) | Coding Plan quota windows, MCP allowance, plan name, and renewal date |

## Shared references

See the package README for [current and configured accounts](../../README.md#-current-and-configured-accounts), [settings](../../README.md#-settings), and [security and privacy](../../README.md#-security-and-privacy).
[Target selection](../operations.md#choose-a-provider-target) applies when a provider exposes several billing targets.
[Display templates](../statusline-display.md) describe shared quota formatting and countdown behavior.
