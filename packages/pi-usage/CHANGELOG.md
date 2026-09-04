# @narumitw/pi-usage

## 0.60.3

### Patch Changes

- cb85e77: Keep the Settings frame from hiding interactive rows in short terminals.
- 96ab4db: Render the standard horizontal frame around the pi-usage Settings screen.
- 4cf2daa: Render the usage menu with the standard horizontal frame used by other Pi extension menus.

## 0.60.2

### Patch Changes

- a5c4a61: Render consistent MiniMax Token Plan rows with zero countable quota as percent-based buckets, reject contradictory zero-total counts, fall back to the general group in the status chip, and show query-failed messages in the chip.

## 0.60.1

### Patch Changes

- cd0ee28: Add a provider-neutral usage target picker, starting with Fireworks accounts, and remove the free-form Fireworks account setting.

## 0.60.0

### Minor Changes

- bf71c9b: Add Z.AI plan support: query the undocumented `GET {origin}/api/biz/subscription/list` plan endpoint after the quota windows and report the GLM Coding Plan name and renewal date, falling back to the quota response's plan level when the plan endpoint is unavailable. Z.AI percentage windows now render usage bars in `/usage`, matching the Codex report. OpenCode Zen and xAI percentage windows now use the same shared usage bars. Z.AI window lengths and the session label derive from the payload's `(unit, number)` window pair instead of hardcoded constants, with the previous 5-hour and weekly values as fallbacks.

### Patch Changes

- c988f0a: Select the current valid Z.AI subscription instead of reporting an earlier expired plan.

## 0.59.0

### Minor Changes

- ed425e0: Add MiniMax Global and China Token Plan quota and pay-as-you-go balance reporting with deterministic credential routing.
- db89cb1: Add Vercel AI Gateway credit reporting with exact remaining balance and lifetime spend from the official credits endpoint.
- 6a23d01: Add Moonshot AI Global and China API balance reporting with region-bound credentials, shared environment-key safeguards, and native USD or CNY semantics.
- 0400845: Add trailing 30-day Baseten organization Model APIs spend reporting with credits and net subtotal.

### Patch Changes

- c3947f7: Prevent Codex reset countdown timers from crashing Pi when their captured extension context becomes stale during session replacement.

## 0.58.0

### Minor Changes

- 42d650a: Add Fireworks rated API spend reporting for the official fireworks provider, summarizing the trailing 30 days of rated costs per currency with serverless, dedicated-deployment, and training subtotals from the documented billing summary endpoint.
  
  The account slug is discovered through the documented account listing when exactly one account is visible; keys that can see several accounts set `fireworksAccountId` in `pi-usage.json`. Fireworks exposes no credit-balance or spend-cap endpoint, so the report claims only rated spend.

### Patch Changes

- Updated dependencies [fc6fab5]
- Updated dependencies [636fd3c]
  - @narumitw/pi-tui-kit@0.60.0

## 0.57.0

### Minor Changes

- 5c4f8ec: Remove the xAI usage setting and always offer xAI OAuth subscription reporting through explicit `/usage` actions without background or statusline requests.
- ac72cb1: Show compact Codex reset countdowns in the statusline by default, with a setting to restore the legacy window labels.

## 0.56.0

### Minor Changes

- bcb8197: Add exact DeepSeek API balance reporting for official runtime API keys.

## 0.55.0

### Minor Changes

- 948affd: Publish Z.AI remaining five-hour and weekly plan percentages in the statusline.

## 0.54.0

### Minor Changes

- c00bcfe: Add source-backed Kimi For Coding plan-window and booster-wallet usage reporting.
- 2681749: Add default-enabled xAI OAuth subscription usage reporting based on the official Grok Build implementation.
  
  xAI API-key accounts remain unsupported and are directed to the xAI console.

## 0.53.0

### Minor Changes

- bfb415e: Add Z.AI (GLM Coding Plan) usage support for the official zai and zai-coding-cn providers, reporting explicit used and remaining values for the rolling 5-hour and weekly plan windows, monthly MCP allowance with per-tool details, reset times, and the plan level.

## 0.52.3

### Patch Changes

- d74a181: Use the canonical OpenCode Go usage endpoint regardless of the selected model's base URL.

## 0.52.2

### Patch Changes

- 42e8940: Allow current-account consumers to verify named OAuth credentials through a process-local protocol, including GitHub Copilot usage and OpenAI Codex reset flows.

## 0.52.1

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.52.0

### Minor Changes

- ab49f5b: Add OpenCode Go Zen usage reporting for rolling, weekly, and monthly quota windows.

## 0.51.0

### Minor Changes

- e71cf31: Add persistent OpenAI Codex Fast routing with a `/fast` shortcut, a contextual `/usage` toggle, explicit usage guidance, and effective statusline labeling.

## 0.50.0

### Minor Changes

- a5b0feb: Add safe redemption of earned OpenAI Codex usage-limit resets for the current matching Pi OAuth account.

### Patch Changes

- Updated dependencies [2d79365]
  - @narumitw/pi-tui-kit@0.50.0
