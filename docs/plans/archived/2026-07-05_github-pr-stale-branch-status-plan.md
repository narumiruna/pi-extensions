## Goal

修正 `@narumitw/pi-github-pr` 在 Git branch 切換後殘留上一個 PR 狀態的問題。成功條件是切到沒有 PR 的 `main` 或新 branch 時，不會再由 `pi-statusline` 顯示 `main (#4)` 這類「目前 branch + 舊 PR」組合；切到有 PR 的 branch 時會顯示該 branch 的正確 PR。

## Context

- `extensions/pi-github-pr/src/github-pr.ts` 原本只在 `session_start`、`agent_end` refresh，`session_shutdown` clear；沒有監聽 Git branch change。
- `extensions/pi-statusline/src/statusline.ts` 的 branch segment 會用目前 Git branch 加上 `github-pr` status 裡的 PR link，所以 branch 已更新但 `github-pr` status 尚未 refresh/clear 時，就會出現 `main (#4)`。
- 本機在 `main` 執行 `gh pr view --json number,url,headRefName` 回傳 `no pull requests found for branch "main"`，代表 `gh` refresh 會正確清空；問題是沒有在 branch change 當下 refresh/clear。

## Non-Goals

- 不新增 GitHub API client、polling loop、slash command 或 PR 討論內容讀取。

## Plan

- [x] 在 `extensions/pi-github-pr/test/github-pr.test.ts` 加上 stale PR regression test：模擬已顯示 PR #4 後 branch change callback 發生，預期先 clear `github-pr` status，且舊 refresh 完成後不能再寫回；已先用 `npm test -- --test-name-pattern='branch changes clear stale PR status|session shutdown disposes|branch watcher failures'` 驗證 regression test 失敗，再用 `npm test` 驗證通過。
- [x] 在 `extensions/pi-github-pr/src/github-pr.ts` 加最小 branch watcher：`session_start` 用 `git rev-parse --git-path HEAD` 找 `.git/HEAD`，`fs.watch` HEAD；watch 失敗或非 Git repo 時維持現有 session/agent-end refresh；已用 `branch watcher failures stay non-intrusive` 測試驗證。
- [x] 在 watcher 事件中立即 `clearStatus(ctx)`、遞增 refresh generation、debounce 一次 `runGhPrView()`；已用 `branch changes clear stale PR status and stale refreshes cannot restore it` 測試驗證切 branch 後狀態先清空，再刷新成空值。
- [x] 對 `refreshStatus` 加 generation/race guard，讓較舊的 `gh pr view` 結果不能覆蓋 branch change 後的狀態；已用 `branch changes clear stale PR status and stale refreshes cannot restore it` 測試驗證慢速舊 PR 查詢不會重新顯示 #4。
- [x] 在 `session_shutdown` 關閉 watcher、清 debounce timer、clear `github-pr` status；已用 `session shutdown disposes the branch watcher and pending refresh` 和 lifecycle 測試驗證。
- [x] 更新 `extensions/pi-github-pr/README.md` 的 Behavior/Known limits，說明會在 Git branch change 時清空並刷新，仍不做連續 polling；已用 `rg -n "branch change|polling|session start|agent turn|session_start|agent_end" extensions/pi-github-pr/README.md` 驗證。
- [x] 跑驗證命令：`npm test`、`npm run check`、`npm run pack:github-pr`，確認測試、型別、格式與 package contents 都通過。

## Risks

- `fs.watch` 在少數檔案系統可能漏事件；現有 `session_start`/`agent_end` refresh 仍作為 fallback。
- Watch callback 會持有 session context；已用 session/generation guard 和 `session_shutdown` cleanup 降低 reload/session replacement 後 stale callback 寫狀態的風險。

## Completion Checklist

- [x] 切到沒有 PR 的 branch 時不再顯示舊 PR，經 `branch changes clear stale PR status and stale refreshes cannot restore it` regression test 驗證。
- [x] 慢速舊 refresh 不會覆蓋新 branch 狀態，經 `npm test` 的 race test `branch changes clear stale PR status and stale refreshes cannot restore it` 驗證。
- [x] README 行為描述和實作一致，經 `rg -n "branch change|polling|session start|agent turn|session_start|agent_end" extensions/pi-github-pr/README.md` 和人工檢查驗證。
- [x] `npm test`、`npm run check`、`npm run pack:github-pr` 全部通過。
