## Status

完成。實作已在 PR #24（`feat/codex-usage-extension`）中送出，包含 `/codex-status`、`openai-codex` model 自動 statusline、Pi auth direct backend、Codex app-server fallback、README/root metadata、local install 與 package verification。

## Goal

建立一個新的 Pi extension package，讓使用者可在 Pi 中查看目前 Codex ChatGPT/subscription 使用量，效果接近在 Codex TUI 輸入 `/status` 時看到的 rate limit、reset time、credits 與 plan 資訊。

成功條件是新增的 extension 能透過一個明確命令（建議 `/codex-status`）安全地查詢 Codex 使用量、格式化為可讀輸出、在沒有 Codex CLI 或未登入時給出可行錯誤訊息，並符合本 monorepo 的 package、README、typecheck 與 pack 驗證規範。

## Context

已檢視 `third_party/codex` 中和 `/status` 使用量相關的實作：

- `codex-rs/tui/src/chatwidget/slash_dispatch.rs`：`/status` 會觸發 rate-limit refresh。
- `codex-rs/tui/src/status/rate_limits.rs` 與 `codex-rs/tui/src/status/card.rs`：將 `RateLimitSnapshot` 格式化為 5h/weekly limits、credits、reset time。
- `codex-rs/app-server/src/request_processors/account_processor.rs`：app-server 的 `account/rateLimits/read` 會讀 Codex account rate limits。
- `codex-rs/backend-client/src/client.rs`：實際呼叫 `GET /wham/usage` 或 `/api/codex/usage`，並轉成 `RateLimitSnapshot`。
- `codex-rs/app-server/README.md`：app-server 支援 stdio JSON-RPC，並要求先 `initialize` 再呼叫 `account/rateLimits/read`。

## Architecture

採用多來源查詢策略，讓未安裝 Codex CLI 的 Pi 使用者也有機會使用：

1. **Primary：Pi auth direct backend**。若 Pi 目前 model/provider 已透過 ChatGPT/Codex subscription auth 登入，優先使用 `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` 取得 Pi 已有的 bearer token 與 headers，直接呼叫 Codex backend usage endpoint。
2. **Fallback：Codex app-server**。若 Pi auth 不可用但本機有 Codex CLI，才 spawn `codex app-server --listen stdio://` 並呼叫 `account/rateLimits/read`，交給 Codex 處理 token refresh 與 auth storage。
3. **No auth source**。若既沒有 Pi ChatGPT/Codex auth，也沒有 Codex CLI/auth，extension 只能回報「缺少可用認證來源」；不能在沒有任何登入憑證的情況下取得 subscription quota。

建議資料流：

```text
Pi /codex-status command
  -> try Pi modelRegistry auth
  -> if available: GET https://chatgpt.com/backend-api/wham/usage
  -> else if codex exists: spawn `codex app-server --listen stdio://` + account/rateLimits/read
  -> parse RateLimitStatusPayload or GetAccountRateLimitsResponse
  -> format status lines
  -> render in Pi notification/custom modal/tool result
```

新 package 建議：

```text
extensions/pi-codex-usage/
├── LICENSE
├── README.md
├── package.json
├── tsconfig.json
└── src/
    └── codex-usage.ts
```

核心模組可先集中在 `src/codex-usage.ts`；若檔案過大，再拆成：

- `pi-auth-backend-client.ts`：使用 Pi modelRegistry auth 直接呼叫 Codex usage endpoint。
- `codex-app-server-client.ts`：可選 fallback，spawn/stdin/stdout JSON-RPC client、timeout、cleanup。
- `rate-limit-format.ts`：純格式化與 reset time 顯示。
- `codex-usage.ts`：Pi extension entrypoint、auth source selection、command/UI glue。

## Tech Stack

- TypeScript Pi extension，使用新版 `@earendil-works/pi-coding-agent` 型別與 Node built-ins；不再為新 package 使用已 deprecated 的 `@mariozechner/pi-*` 套件。
- Node `fetch` 直接呼叫 Codex backend usage endpoint。
- Node `child_process.spawn` 與 `readline`/stream parser 只用於 Codex app-server fallback。
- 不在 MVP 新增 runtime dependency；只有在 mock/test 或格式化需求明確時才增加。

## Non-Goals

- 不直接解析、修改或刷新 `~/.codex/auth.json`。
- 不實作獨立 footer/statusline renderer；只透過 Pi `setStatus` 暴露 compact usage，讓現有 statusline 顯示 extension status。
- 不支援 OpenAI API key 的 platform rate limits；此功能聚焦 Codex ChatGPT/subscription quota。
- 不複製 Codex TUI 的完整 `/status` 卡片，只提供 Pi 內可讀的使用量摘要。

## Assumptions

- 使用者若沒有 Codex CLI，仍可能已在 Pi 內使用 OpenAI ChatGPT Plus/Pro (Codex) subscription auth。
- API key auth 不會回傳 Codex subscription usage；direct backend path 只對 ChatGPT/Codex bearer auth 有意義。
- Pi extension package 可在 command handler 中短暫 spawn 子程序並在完成後清理，但這只是 fallback，不是必要條件。

## Resolved Findings

- Pi `openai-codex` auth 可透過 `ctx.modelRegistry.getApiKeyAndHeaders(...)` 取得 bearer token，並成功呼叫 `https://chatgpt.com/backend-api/wham/usage`。
- Direct backend response 對齊 Codex `RateLimitStatusPayload` snake_case 欄位；實作已加入 runtime parsing/normalization，將 direct backend 與 app-server response 轉成同一個 internal snapshot。
- 本機 Codex CLI `codex app-server --listen stdio://` fallback 已對照 help/protocol 文件，並以 smoke test 驗證可回傳 usage。
- MVP 呈現方式定案：`/codex-status` 用 `ctx.ui.notify` 顯示完整摘要；當目前 model provider 是 `openai-codex` 時，用 `ctx.ui.setStatus` 顯示 compact statusline，切換 away 時清除。

## Plan

- [x] 建立 `extensions/pi-codex-usage` package scaffold，包含 `package.json` 的 `pi.extensions`、`files`、scripts、`@earendil-works/pi-coding-agent` dev dependency 與 `tsconfig.json`；用 `npm --workspace @narumitw/pi-codex-usage run typecheck` 驗證 package 能被 workspace 辨識。
- [x] 在 root `package.json`、`justfile`、root `README.md` 加入 `pi-codex-usage` 的 check/pack/try/install/publish 入口與 package 表格說明；用 `just --list | rg 'codex-usage'` 和 root README diff 驗證入口完整。
- [x] 實作 Pi auth direct backend client，從 `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` 取得可用 auth，呼叫 `https://chatgpt.com/backend-api/wham/usage`，並在 auth 不可用、HTTP 401/403、payload unsupported 時回傳結構化錯誤；用 real Pi auth smoke test 與 fixture import 驗證 success 與 formatter code path。
- [x] 實作可選 Codex app-server JSON-RPC fallback client，能在 direct backend 不可用且 `codex` executable 存在時 spawn `codex app-server --listen stdio://`、送出 `initialize`、送出 `initialized` notification、呼叫 `account/rateLimits/read`、在 timeout/exit/error 時清理 process；用 `codex app-server --help` 對照 flag 與 protocol 文件驗證 handshake。
- [x] 定義 TypeScript 型別 `RateLimitStatusPayload`、`RateLimitWindow`、`RateLimitSnapshot`、`GetAccountRateLimitsResponse`，對齊 `third_party/codex/codex-rs/backend-client/src/client.rs` 與 `app-server-protocol/schema/typescript/v2/*`；用 `npm --workspace @narumitw/pi-codex-usage run typecheck` 驗證型別與 parser 編譯通過。
- [x] 實作 rate-limit normalization 與 formatting，把 direct backend payload 和 app-server response 都轉成同一個 internal snapshot，再輸出每個 limit bucket 的 used/left percent、window label（例如 5h/weekly）、reset time、credits 與 unavailable/missing 狀態；用 fixture JSON 驗證 5h、weekly、multi-bucket 與 credits 文字輸出。
- [x] 註冊 `/codex-status` command，依序嘗試 Pi auth direct backend 與 Codex app-server fallback，顯示 loading/activity status，完成後用 Pi UI 顯示摘要，錯誤時提供「在 Pi 內登入 ChatGPT/Codex subscription / 安裝 Codex CLI 作 fallback / 此功能不支援 API key quota」等下一步；用 direct command-handler smoke test 驗證 Pi auth 路徑可運作。
- [x] 加入 5–15 分鐘記憶體快取與 `--refresh` 參數，避免連續 `/codex-status` 頻繁打 Codex backend；用 implementation review 驗證第二次命令使用 cache，而 `/codex-status --refresh` 會重新查詢。
- [x] 更新 `extensions/pi-codex-usage/README.md`，說明安裝、`/codex-status` 用法、優先使用 Pi ChatGPT/Codex auth、不需要安裝 Codex CLI、Codex CLI 只是 fallback、MVP 不支援 API key quota、錯誤排查與隱私注意事項，且風格對齊其他 extension README；用 README review 和 `npm run check` 驗證文件與格式。
- [x] 執行 repository verification，包含 `npm run check` 與 `just pack codex-usage`，並檢查 dry-run tarball 只包含 `src`、`README.md`、`LICENSE` 與 package metadata；用命令輸出作為驗證證據。
- [x] 若 MVP 驗證穩定，再評估是否新增 optional widget/footer 顯示（預設關閉）；本版不新增獨立 widget/footer，但依使用者要求在目前 model provider 為 `openai-codex` 時透過 `setStatus` 顯示 compact usage，並每 5 分鐘刷新。

## Verification

- `rg --no-ignore -n "@earendil-works|@mariozechner" extensions/pi-codex-usage`: verified pi-codex-usage uses `@earendil-works/pi-coding-agent` and no deprecated `@mariozechner/pi-*` package.
- `npm --workspace @narumitw/pi-codex-usage run typecheck`
- `npm --workspace @narumitw/pi-codex-usage run check`
- `just --list | rg 'codex-usage'`
- `node --experimental-strip-types --input-type=module ...` direct command-handler smoke test with real Pi `openai-codex` auth: verified `Source: Pi auth direct` output.
- `node --experimental-strip-types --input-type=module ...` fallback smoke test with empty Pi auth candidate list: verified `Source: Codex app-server` output.
- `node --experimental-strip-types --input-type=module ...` cache fixture: verified two normal calls plus one `--refresh` result in two fetches.
- `node --experimental-strip-types --input-type=module ...` missing-auth/no-`codex` fixture: verified error notification includes both source failures.
- `node --experimental-strip-types --input-type=module ...` automatic statusline fixture: verified `session_start` with `openai-codex` sets `codex <5h>% 5h <weekly>% wk`, and `model_select` away clears it.
- `npm run check`
- `just pack codex-usage`

## Risks

- Pi subscription auth headers 可能不足以直接呼叫 Codex usage endpoint，導致未安裝 Codex CLI 的路徑需要額外 provider 支援。
- Codex app-server protocol 或 CLI flags 可能變動，造成 fallback 和某些版本不相容。
- 每次 command 都啟動 app-server fallback 可能偏慢；若保留常駐 process，則需更仔細處理 session shutdown 與 zombie process。
- 使用量資料可能是瞬時快照；過度常駐顯示會讓使用者誤以為是即時資訊。
- 錯誤訊息若包含 backend body，可能意外暴露敏感資訊；需要避免輸出 token、完整 auth headers 或過長 response body。

## Rollback / Recovery

若新 package 造成 publish 或 install 問題，可只回滾 package registration 相關檔案（root `package.json`、`justfile`、root `README.md`）並保留未發布的 `extensions/pi-codex-usage` 目錄作後續修正。若已發布 npm package 且發現重大問題，發布 patch 版停用 command 或在 README 標示 known issue；不要要求使用者修改 Codex auth storage。

## Completion Checklist

- [x] `@narumitw/pi-codex-usage` package scaffold 已建立，並由 `npm --workspace @narumitw/pi-codex-usage run typecheck` 驗證。
- [x] `/codex-status` 能優先使用 Pi ChatGPT/Codex auth direct backend 查詢 usage，並由 direct command-handler smoke test 驗證成功路徑。
- [x] Codex app-server fallback 可在 direct backend 不可用且本機有 Codex CLI 時查詢 `account/rateLimits/read`，並由 protocol/flag 對照與 typecheck 驗證。
- [x] 未安裝 Codex CLI、未登入 Pi ChatGPT/Codex auth、API key auth、不支援 usage payload 等錯誤情境都有明確使用者訊息，並由 implementation review 和 fixture import 驗證。
- [x] Rate-limit output 包含 used/left percent、reset time、credits 與 multi-bucket 資訊，並由 fixture output review 驗證。
- [x] 快取、`--refresh` 與 `openai-codex` automatic statusline 行為已實作，並由 fixture/implementation review 驗證不會無限制頻繁查詢 backend。
- [x] Root workspace metadata、README 與 just recipes 已包含 `pi-codex-usage`，並由 `just --list | rg 'codex-usage'` 與 README review 驗證。
- [x] Repository gate 通過 `npm run check`，package dry run 通過 `just pack codex-usage` 且 tarball 內容正確。
