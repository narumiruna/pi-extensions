# pi-goal 自動建立設定檔

## Goal

讓 pi-goal 在 session start 發現設定檔不存在時，自動建立含完整預設值的 `pi-goal.json`，且不覆寫任何既有檔案。

## Plan

- [x] 先在 `extensions/pi-goal/test/settings.test.ts` 加入 load-or-create 的紅燈測試，涵蓋建立預設檔、保留有效/無效檔、發佈失敗清理與競爭建立。紅燈：缺少新匯出與 lifecycle 建檔時發生 `ENOENT`；綠燈：`npm test` 的 1,124 項測試通過。
- [x] 在 `extensions/pi-goal/src/settings.ts` 實作同目錄暫存檔、exclusive hard-link 發佈、競爭重讀及明確建立失敗結果。
- [x] 在 `extensions/pi-goal/src/goal.ts` 將 session start 接到 load-or-create，並在 `extensions/pi-goal/test/goal.test.ts` 驗證 lifecycle 建檔、失敗 warning 與既有預設行為。
- [x] 更新 `extensions/pi-goal/README.md` 的自動建立、預設內容、reload 與不覆寫保證。
- [x] 執行相關測試、`npm run typecheck --workspace @narumitw/pi-goal` 與 `npm run check`。證據：workspace typecheck 通過；完整 check 的 1,124 項測試全數通過。

## Completion Checklist

- [x] 缺失設定在首次 session start 後成為可解析、格式化、含結尾換行的完整預設 JSON。
- [x] 既有有效或無效設定不被覆寫；競爭建立採用先完成的檔案。
- [x] 建立失敗使用內建預設、顯示 warning 且不留下暫存檔。
- [x] 文件與實際 lifecycle 行為一致，所有驗證通過。
