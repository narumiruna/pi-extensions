## Goal

讓使用者看完 `/btw` 回答後，可直接在同一個暫時 side thread 內輸入下一題；模型能收到先前的 side Q&A，而整串內容仍不寫入 Pi 主對話或 session。

成功條件：`/btw`直接開啟空白side thread，`/btw <question>`可立即送出第一題；每次回答後同時顯示完整side transcript與可立即輸入的editor；`Enter`送出問題，`Ctrl+C`取消生成或離開thread；後續provider request包含先前成功的side turns。

## Architecture

- 每次 `/btw` invocation建立一個記憶體內 `SideThread`，包含啟動時擷取一次的主branch context，以及依序排列的user/assistant side turns。
- Model、credentials與thinking level在thread開始時解析一次，避免follow-up中途切換執行環境。
- 第一個provider request包含主對話context；後續request沿用第一個user message與完整成功side turns，不重複嵌入主context。
- `extensions/pi-btw/src/side-thread.ts`負責provider messages、completion與turn commit；失敗turn只顯示在transcript，不加入後續provider context。
- `extensions/pi-btw/src/transcript-pager.ts`以Pi原生user/assistant message components渲染可捲動transcript與editor，不加入Q編號、role labels、turn count、分隔線或進度百分比。`Enter`提交，`PgUp`/`PgDn`捲動歷史，`Ctrl+C`是明確的退出操作；`q`與`Esc`不退出。
- `extensions/pi-btw/src/btw.ts`負責transcript/editor → loader迴圈；有command參數時可跳過第一次空白composer並直接送出。回答生成期間取消會結束整個side thread，且late provider response不得再寫入thread。
- Side thread僅存活於command handler；不呼叫`pi.sendMessage()`、`pi.sendUserMessage()`或`pi.appendEntry()`。

## Important behavior changes

- `/btw`無參數時直接進入空白composer；回答完成後同一個editor持續可用，不需要額外快捷鍵。
- `Enter`送出follow-up；空白問題留在editor並顯示提示。
- `Ctrl+C`取消目前生成或關閉side thread；`q`與`Esc`保留給文字輸入。
- 主對話只作為背景；side thread不改變目前Pi model、thinking level或session branch。
- Thread不跨`/btw` invocation、`/reload`或session切換保留。

## Non-Goals

- 不建立持久化side-chat history、thread selector或多個同時存在的side threads。
- 不支援side thread內工具呼叫、主動修改檔案或串流token UI。
- 不包含conversation text selection、滑鼠selection或clipboard整合。
- 不修改`pi-btw.json` schema、package version或publish workflow。

## Plan

- [x] 在`extensions/pi-btw/test/side-thread.test.ts`加入provider sequence、取消競態與command state-machine測試；以首次缺少新模組的`npm test`證明red phase。
- [x] 將單題completion重構成`extensions/pi-btw/src/side-thread.ts`的累積runner；captured `completeSimple()` calls驗證三題message sequence、單次主context與固定model/auth/thinking level。
- [x] 將回答UI拆成`extensions/pi-btw/src/transcript-pager.ts`的整合transcript/editor component；component tests驗證Pi原生訊息樣式、無額外role/turn裝飾、窄寬度、長內容、捲底、空白輸入、`Enter`提交及只有`Ctrl+C`退出。
- [x] 在command handler實作可從空白composer或command初始問題開始的transcript/editor → loader迴圈；注入式tests驗證第一題輸入、連續追問、生成取消立即退出及late response不復活。
- [x] 更新`extensions/pi-btw/README.md`，記錄inline follow-up、按鍵與ephemeral/non-polluting語意。
- [x] 以`npm run check`與`just pack-btw`驗證；互動式Pi TUI smoke依repository execution policy標示不適用。

## Risks

- Side turns會持續增加provider context；第一版保留啟動時已受40,000字元限制的主context及本次invocation完整成功turns。Provider context overflow會顯示錯誤，不靜默截斷。
- Provider可能在取消後仍回傳成功；completion在await前後都檢查abort signal，避免late response污染thread。
- Model/user文字可能包含terminal controls；transcript顯示層轉義C0/C1 controls，provider payload仍保留原始內容。

## Completion Checklist

- [x] 連續三題provider requests有正確且不重複的Q/A順序，由`side thread sends prior successful turns and injects main context only once`驗證。
- [x] `/btw`可先顯示0-turn composer，回答後可直接輸入下一題，且`q`/`Esc`不退出、`Ctrl+C`退出，由command-loop與transcript composer tests驗證。
- [x] 取消中的late response不新增turn，由`side thread discards a late successful response after cancellation`驗證。
- [x] 單題`/btw <question>`、設定fallback、model/auth與thinking-level既有行為由root `npm run check`驗證。
- [x] Side Q&A不寫入主branch；runner只讀`getBranch()`且無session mutation API，由source review與tests驗證。
- [x] npm tarball僅包含預期metadata與follow-up runtime modules，由`just pack-btw`驗證。
