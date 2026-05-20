## Goal

讓 `pi-statusline` 可用環境變數切換 statusline preset，先支援 `classic` 與 `tokyo-night`，並保留目前資訊內容、emoji、第二行 extension statuses 與安全截斷行為。

## Context

目前 `extensions/pi-statusline/src/statusline.ts` 已改為 Tokyo Night 配色的 Starship-inspired powerline renderer。靈感來源是 Starship Tokyo Night preset（https://starship.rs/presets/tokyo-night），其格式使用 `░▒▓` 開頭、`` powerline 銜接與 `#a3aed2`、`#769ff0`、`#394260`、`#212736`、`#1d2230` 色階。為避免破壞偏好原本樣式的使用者，下一步應恢復 classic renderer 並新增 preset selector，而不是拆成另一個 extension。

## Non-Goals

- 不解析 Starship TOML。
- 不新增 YAML/JSON config。
- 不做任意 palette/layout 自訂。
- 不新增 runtime dependency。

## Assumptions

- `PI_STATUSLINE_PRESET=tokyo-night` 啟用新版 powerline 外觀。
- `PI_STATUSLINE_PRESET=classic` 啟用原本外觀。
- 未設定或設定無效時先使用 `tokyo-night` 作為目前新版預設；若要避免 breaking change，可在實作前改成 `classic`。

## Plan

- [x] 在 `extensions/pi-statusline/src/statusline.ts` 新增 `StatuslinePresetName = "classic" | "tokyo-night"` 與 `readStatuslinePreset()`，從 `process.env.PI_STATUSLINE_PRESET` 讀取 preset；已由 `rg "PI_STATUSLINE_PRESET|StatuslinePresetName" extensions/pi-statusline/src` 與 `npm run check --workspace @narumitw/pi-statusline` 驗證。
- [x] 將目前 Tokyo Night powerline renderer 保留為 `renderTokyoNightStatusline()`，並讓 `renderStatusline()` 依 config preset dispatch；已由 `extensions/pi-statusline/presets/tokyo-night.ts` 與 `renderStatusline()` switch 驗證，`tokyo-night` 路徑保留 `░▒▓` / `` truecolor blocks。
- [x] 從 git diff 或先前版本還原 classic renderer 所需邏輯：`RIGHT_SEGMENTS`、palette/density/separator、`joinSegments()`、`styleSegment()`、`thinkingColor()`、`contextColor()` 與 labeled segment color；已由 `extensions/pi-statusline/presets/classic.ts`、`pickColor()`、`thinkingColor()`、`contextColor()` 與 typecheck 驗證。
- [x] 依使用者要求將各 preset 拆成不同 `.ts` 檔，包含 `extensions/pi-statusline/presets/classic.ts`、`extensions/pi-statusline/presets/tokyo-night.ts`、`extensions/pi-statusline/presets/ansi.ts`、`extensions/pi-statusline/presets/types.ts`；已由 `find extensions/pi-statusline -path '*presets/*.ts' -type f` 與 typecheck 驗證。
- [x] 調整 shared segment model，確保 classic 需要的 `color` 與 tokyo-night 需要的 `block` 不互相污染；已由 `RenderSegment` 同時帶 `color` / `block`，preset renderer 各自只消費需要欄位，並由 `npm run check --workspace @narumitw/pi-statusline` 驗證。
- [x] 讓第二行 extension statuses 依 preset 使用 separator：classic 使用 Pi theme dim `•`，tokyo-night 使用 truecolor powerline-compatible ``；已由 `extensionStatusSeparator()`、`classicExtensionSeparator()`、`tokyoNightExtensionSeparator()` 與 typecheck 驗證。
- [x] 更新 `extensions/pi-statusline/README.md`，記錄 `PI_STATUSLINE_PRESET=classic|tokyo-night`、預設值、無效值 fallback、emoji 仍保留、以及 Tokyo Night 靈感來源連結；已由 `rg "PI_STATUSLINE_PRESET|https://starship.rs/presets/tokyo-night" extensions/pi-statusline/README.md` 驗證。
- [x] 執行 `npm run check --workspace @narumitw/pi-statusline`、`npm run check`、`just pack-statusline`；三個命令皆成功，pack dry-run 列出預期 package files：`LICENSE`、`README.md`、`package.json`、`src/statusline.ts` 與 `presets/*.ts`。

## Risks

- 同時維護 classic 與 tokyo-night renderer 會增加少量重複邏輯；已以共用資料收集與小型 renderer function 控制範圍。
- ANSI truecolor/bold reset 可能影響截斷或背景延續；已保留 `truncateToWidth(..., "")`，且 Tokyo Night renderer 不手動依 visible string 長度切割 ANSI 字串。

## Completion Checklist

- [x] `PI_STATUSLINE_PRESET` 支援 `classic` 與 `tokyo-night`，由 `extensions/pi-statusline/src/statusline.ts` 中的 preset selector 與 dispatch 邏輯驗證。
- [x] Classic 外觀可用且保留原本 emojis、左右分欄與 separator，由 `extensions/pi-statusline/presets/classic.ts`、shared segment builder 與 typecheck 驗證。
- [x] Tokyo Night 外觀可用且保留 `░▒▓` / `` blocks 與 emojis，由 `extensions/pi-statusline/presets/tokyo-night.ts`、shared segment builder 與 typecheck 驗證。
- [x] Extension statuses 第二行仍保留 emoji icon preservation，由 `formatExtensionStatus()` / `splitExtensionStatusIcon()` 未破壞、preset-specific separator 與 check 通過驗證。
- [x] README 記錄環境變數切換方式與 Tokyo Night preset 靈感來源，由 `extensions/pi-statusline/README.md` 內容驗證。
- [x] 品質門檻通過，由 `npm run check --workspace @narumitw/pi-statusline`、`npm run check`、`just pack-statusline` 成功輸出驗證。
