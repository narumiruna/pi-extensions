# Extension E2E Test Plan

## Goal

加入一套不需要真實模型憑證、可重現且有明確逾時的 E2E 測試，透過 repository
安裝的 Pi CLI/RPC 驗證所有 active extension 的實際載入與關閉，並以 `pi-goal` 驗證一條
真實 prompt → model response → tool → persisted state 流程；讓目前 CI 的 latest-Pi 相容性
檢查能發現單元測試及 mock lifecycle 無法發現的 runtime 整合錯誤。

## Context

- `scripts/run-tests.mjs` 目前只編譯並執行 `*.test.ts`，主要涵蓋 unit/integration tests，
  不會啟動真正的 Pi CLI process。
- `.github/workflows/ci.yml` 會先把 Pi packages 更新成 latest，再只執行 `npm run check`。
- `extensions/pi-goal/test/goal-runtime-smoke.mjs` 已使用 Pi SDK、in-memory session 與 faux
  provider 做 deterministic runtime smoke，但 `npm run check` 不會執行 package 的
  `test:runtime` script。
- 本機全域 `pi` 與 repository manifest 版本可能不同；E2E 必須使用
  `node_modules/.bin/pi`，不能依賴 `PATH` 上的全域 binary。
- Pi RPC 使用嚴格 JSONL framing；只能以 LF 分割 records，不能使用 Node `readline`。

## Architecture

- 新增獨立的 `e2e/` TypeScript suite 與 `tsconfig.e2e.json`，輸出到
  `node_modules/.cache/pi-extensions-e2e`，避免被現有 unit-test discovery 混入。
- `e2e/support/pi-rpc-harness.ts` 負責啟動 repository-local Pi、嚴格解析 JSONL、關聯
  response id、收集 events/stderr、執行逾時與 process-tree cleanup。
- 每個 scenario 使用獨立的 temporary workspace、`PI_CODING_AGENT_DIR` 與 session dir，並
  開啟 offline/no-discovery flags；不讀取開發者的 settings、credentials、sessions 或
  project resources。
- `e2e/fixtures/control-extension.ts` 提供測試專用 inspect/shutdown command，並在
  `session_shutdown` 寫入 sentinel，讓測試能證明 command routing 與 graceful lifecycle
  cleanup 都完成。
- 載入 smoke 以每個 active package 一個隔離 Pi process 執行，直接傳入 package directory，
  讓 Pi 依 `package.json#pi.extensions` 載入正式 entrypoint；個別隔離可避免 extension
  狀態互相污染並提供精確失敗歸屬。
- 一條 `pi-goal` functional scenario 以 test-only faux provider 回應固定內容，從 RPC 送出
  `/goal`，等候 `agent_settled`，再由 messages/session evidence 驗證 `goal_complete` tool 與
  completed state。既有較深入的 SDK runtime smoke 也納入 E2E runner。
- `npm run test:e2e` 是獨立入口；完成後由 `npm run check` 呼叫，使既有「CI-equivalent」
  指令仍然成立，CI latest-Pi job 不需依賴另一個未執行的 workflow gate。

## Non-Goals

- 不呼叫 Anthropic、OpenAI、Google 或其他真實外部模型/API。
- 第一階段不自動操作 TUI、PTY、OAuth/browser login 或外部服務。
- 第一階段不加入 Playwright；`pi-webui` 與 `pi-image-drop` 的 browser journey 可在 CLI/RPC
  E2E 穩定後另立計畫。
- 不用 E2E 重複每個 command/tool edge case；細節仍由現有 unit/integration tests 負責。
- 不在第一階段測試 npm registry publish；package contents 仍由 boundary checks 與
  `npm pack --dry-run` 驗證。

## Assumptions

- `npm ci` 後會提供 repository-local Pi CLI 及 faux provider API。
- Active extension 的 isolated default settings 不會主動要求外部憑證；任何 optional server、
  watcher 或 process 都必須能由 `session_shutdown` 關閉。
- Linux GitHub runner 是首要 E2E 平台；process invocation 與路徑處理仍應兼容 Windows 的
  `.cmd` binary 形式。

## Risks

- **Latest Pi API drift：** test-only faux provider API 也可能變動。將 provider fixture 集中在
  單一模組，並保留 CLI load smoke，使 faux fixture 失敗與 extension loader 失敗可區分。
- **Hanging child process：** 每個 request/scenario 都設 deadline；失敗時先 graceful shutdown，
  再終止整個 process group，並輸出 bounded stderr/event tail。
- **共享環境污染：** 不修改 parent process 的 `PI_CODING_AGENT_DIR`；所有 env 只傳給 child，
  temporary directories 必須在成功、失敗與取消路徑清理。
- **執行時間增加：** package smoke 採有限 concurrency，不共用 session；若完整 `npm run check`
  超過可接受時間，先以實測拆出慢點，不以移除 lifecycle/assertions 換取速度。
- **錯誤的正向結果：** 僅看到 process exit 0 不算成功；每個 package 都必須完成 RPC handshake、
  無 `extension_error`、執行 control command，並留下 shutdown sentinel。

## Plan

- [x] 記錄 implementation 前的 active-package inventory、`npm test`、
  `npm --workspace @narumitw/pi-goal run test:runtime` 與 `npm run check` baseline；20 個 active
  packages、repository-local Pi CLI/package 皆為 0.80.10，runtime smoke 通過，`npm test` 與
  `npm run check` 均通過 1,178 tests。
- [x] 新增 `tsconfig.e2e.json` 與 `scripts/run-e2e-tests.mjs`，讓它只編譯/執行 `e2e/**/*.test.ts`
  並使用 cache-local output；no-input run 非零退出，加入最小 Node test 後 runner 與 runtime
  smoke 均通過。
- [x] 先在 `e2e/pi-rpc-harness.test.ts` 寫紅燈 contract tests，涵蓋 fragmented JSONL、CRLF
  input tolerance、字串內 `U+2028/U+2029`、response-id correlation、stderr capture、deadline、
  unexpected exit 及 child cleanup；初次 compile 以缺少 harness module 呈現預期紅燈。
- [x] 實作 `e2e/support/pi-rpc-harness.ts`，從 installed package manifest 解析 repository-local
  CLI，提供 isolated child env、嚴格 LF JSONL、correlated requests、bounded diagnostics、deadline、
  graceful/forced process-group cleanup；8 項 runner/harness tests 通過，process audit 無殘留 child。
- [x] 新增 `e2e/fixtures/control-extension.ts` 與 fixture-focused test，透過 RPC command 發出唯一
  marker、呼叫 graceful shutdown，並在 `session_shutdown` 寫入 sentinel；isolated agent dir、
  credential stripping、重複 close 與 forced-timeout cleanup assertions 均通過。
- [x] 新增 `e2e/extension-load.test.ts`，明列並遞迴驗證 20 個 active packages，逐一以 package
  directory 加載正式 entrypoint，完成 RPC handshake、拒絕 load/extension errors、執行 control
  shutdown 並檢查 sentinel；完整 E2E run 的 20 個具名 package scenarios 全數通過。
- [x] 新增集中式 faux-provider fixture 與 `e2e/pi-goal-flow.test.ts`，由真實 Pi CLI/RPC 執行
  `/goal` 的固定兩步 completion flow，驗證 `goal_complete`、settled/empty queue、tool message、
  cleared persisted goal 與 graceful shutdown；缺少 fixture 時先以 load/provider error 呈現紅燈，
  現已 credential-free/offline 通過。
- [x] 將既有 `extensions/pi-goal/test/goal-runtime-smoke.mjs` 納入
  `scripts/run-e2e-tests.mjs`，保留 SDK-level 深度 scenarios；正常 smoke 通過，並以暫時的
  exit-23 smoke 驗證 runner 原樣轉送非零狀態後還原原檔。
- [x] 更新 root `package.json`，加入 `test:e2e` 並接到 `check` 的 unit tests 之後，另加入
  `just e2e`；實際 `npm run check` 已執行並通過 32 項 E2E tests 與 goal runtime smoke。
- [x] 更新 `docs/extension-conventions.md`，區分 unit/integration、SDK runtime 與 CLI/RPC E2E，
  要求 active package inventory 與 orchestration representative flow；文件明確排除 TUI、browser、
  real-provider 及 external-service coverage。
- [x] 對 intended files 執行 Biome write/check 及完整 `npm run check`（含 boundaries、20
  workspace typechecks、1,178 unit/integration、32 E2E tests 與 goal runtime smoke），另通過
  `git diff --check`；E2E 約 12.4 秒，offline isolated runs 後無殘留 process/temp directory。
- [x] 以 npm 11.16.0/latest-Pi 流程安裝並驗證 0.82.0 CLI/package 後重跑完整
  `npm run check`，1,178 unit/integration 與 32 E2E tests 全數通過；發現原 CI install 仍受 lock
  pin 影響，已加入 `--package-lock=false`，並還原 manifests/lock/node_modules 至 0.80.10。

## Completion Checklist

- [x] `npm run test:e2e` 從 npm 11.16.0 clean install 通過，不需要模型憑證、瀏覽器或外部服務。
- [x] 20 個 active extensions 均經獨立真實 Pi CLI/RPC load、command handshake 與 graceful
  shutdown；明列 inventory 並驗證 canonical entrypoint 存在。
- [x] `pi-goal` prompt-to-tool-to-state 流程經真實 Pi process，既有 SDK runtime smoke 亦由 root
  E2E gate 執行。
- [x] Child process、temporary agent/session/workspace 在成功、失敗及 timeout 路徑清理；bounded
  diagnostics/process-group tests 通過，final process/temp audit 為空。
- [x] Pinned 0.80.10 與 latest 0.82.0 的完整 `npm run check` 均通過，文件準確描述 non-goals。
- [x] Final diff 僅含 E2E infrastructure/tests、必要 scripts/config/CI 修正與 verification docs；
  extension product behavior、package versions 及 lockfile 均未改動。
