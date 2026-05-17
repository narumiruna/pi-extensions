## Goal

研究 `@narumitw/pi-subagents` 是否、以及應該如何變得更主動：讓主 agent 能自行判斷任務是否適合拆成多個 subagent、何時平行化、何時保留在主線完成，最後產出一份有證據的研究結論與 MVP 建議。成功條件是：研究文件明確列出可行方案、風險、第三方實作參考、外部研究/實作來源、以及是否進入實作階段的建議。

## Context

- 目前 `extensions/pi-subagents/src/subagents.ts` 主要註冊一個被動 `subagent` tool；它支援 single、parallel、chain、fan-in aggregator，但沒有 `promptSnippet` / `promptGuidelines`，也沒有透過 `before_agent_start` 動態提醒主 agent 主動拆工。
- 目前 `extensions/pi-subagents/src/agents.ts` 已有 built-in `scout`、`planner`、`reviewer`、`worker`，但主 agent 在決定是否呼叫 `subagent` 前不一定會看到足夠強的「何時使用」規則。
- `third_party/claude-code` 內已有可參考的 multi-agent / coordinator 實作痕跡，包括 `tools/AgentTool/prompt.ts`、`coordinator/coordinatorMode.ts`、`tools/TeamCreateTool/prompt.ts`、`tools/AgentTool/runAgent.ts`。
- Pi extension docs 已提供可能的介入點：tool metadata (`promptSnippet` / `promptGuidelines`)、`before_agent_start` system prompt injection、`sendMessage` / `sendUserMessage`、status UI。

## Non-Goals

- 本計畫不直接要求完成 production implementation；研究完成後再決定是否開實作計畫。
- 不追求「每個任務都自動派 subagent」；研究需明確區分主動使用與過度委派。
- 不預設要複製 Claude Code 的 coordinator/team 架構；只抽取適合 Pi extension 邊界的設計。

## Assumptions

- 第一優先應評估低風險 prompt / tool metadata 方案，再評估 coordinator 或 autonomous scheduler。
- 主動化必須保留成本、延遲、安全確認與寫入衝突控制；不能只以「更多平行 agent」作為成功指標。

## Unknowns

- `promptSnippet` / `promptGuidelines` 是否已足以讓主 agent 更常主動呼叫 `subagent`，或需要 `before_agent_start` 動態注入更強的 orchestration rules。
- Pi extension 是否適合實作真正的 autonomous scheduler，例如在 `agent_end` 後自動追問/續跑，而不造成 feedback loop 或違反使用者期待。
- 若加入動態 agent roster，是否會造成 prompt cache bust、token 成本上升，或與 project-local agent confirmation 安全模型衝突。

## Plan

- [x] 建立研究輸出文件 `docs/implementation-notes/pi-subagents-proactivity-research.md`，放入研究範圍、問題定義、證據表格與結論章節；verify with `test -f docs/implementation-notes/pi-subagents-proactivity-research.md` and `rg -n "Problem|Evidence|Recommendation" docs/implementation-notes/pi-subagents-proactivity-research.md`.
- [x] 盤點目前 `pi-subagents` 的主動性邊界，記錄 `extensions/pi-subagents/src/subagents.ts` 的 `registerTool` metadata、execution modes、status update 與 `extensions/pi-subagents/src/agents.ts` 的 built-in agents；verify with research note containing exact path references and `rg -n "registerTool|promptSnippet|promptGuidelines|before_agent_start" extensions/pi-subagents/src docs/implementation-notes/pi-subagents-proactivity-research.md`.
- [x] 盤點 Pi extension 可用介入點，將 `promptSnippet`、`promptGuidelines`、`before_agent_start`、`sendMessage`、`sendUserMessage`、status UI 對應到可行的 proactivity mechanism；verify with cited references to `/home/narumi/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` in the research note.
- [x] 研究 `third_party/claude-code` 的 multi-agent 實作，至少整理 `tools/AgentTool/prompt.ts`、`coordinator/coordinatorMode.ts`、`tools/TeamCreateTool/prompt.ts`、`tools/AgentTool/runAgent.ts` 的可借鏡模式與不適合直接移植的模式；verify with a table in the research note listing each path, pattern, and Pi applicability.
- [x] 搜尋外部相關研究與實作，收集至少 5 個來源（例如 multi-agent orchestration、task decomposition、tool-use prompting、agent swarm/coordinator UX、Claude Code/Codex 類似功能），每個來源需有 URL、存取日期、重點摘要、對 Pi 的可用性；verify with `rg -n "https?://|accessed|Pi applicability" docs/implementation-notes/pi-subagents-proactivity-research.md`.
- [x] 定義 proactivity levels，從 L0 被動 tool、L1 tool prompt hints、L2 dynamic orchestration prompt、L3 coordinator-style mode、L4 autonomous scheduler 分級，列出觸發條件、成本、實作複雜度與安全風險；verify with a level comparison table in the research note.
- [x] 設計任務拆分判斷 rubric，明確列出適合拆分的情境（獨立 read-only research、多面向審查、implementation 後獨立 verification）與不適合拆分的情境（簡單回答、強共享上下文、同檔案寫入衝突、敏感/高成本任務、project agents 未授權）；verify with at least 8 example prompts classified by the rubric in the research note.
- [x] 評估 MVP 設計選項，至少比較「只加 `promptSnippet` / `promptGuidelines`」、「加 `before_agent_start` 動態提示與 agent roster」、「新增 coordinator mode/command」、「新增 autonomous scheduler」四案；verify with a decision matrix covering correctness, UX, latency, cost, safety, and implementation effort.
- [x] 規劃一個 bounded spike，用 feature flag 或 local-only branch 驗證 L1/L2 是否提高主動呼叫率，包含 6 個測試 prompts（3 個應使用 subagent、3 個不應使用）與 baseline/candidate 結果記錄；verify with an eval matrix saved in the research note and successful `npm run check` if code is touched.
- [x] Not applicable: explicit user review cannot be completed autonomously in goal mode; the `Recommendation` section clearly answers whether proactivity is worthwhile, which MVP level is recommended, and which risks move to the implementation plan, with follow-up review/implementation captured in `docs/plans/2026-05-17_pi-subagents-l1-proactivity-mvp-plan.md`.
- [x] 若使用者接受研究結論，另開 implementation plan for the selected MVP；verify with a new `docs/plans/YYYY-MM-DD_<topic>-plan.md` path or explicit user acceptance that no implementation plan is needed.

## Completion Evidence

- Research output created: `docs/implementation-notes/pi-subagents-proactivity-research.md`.
- Current `pi-subagents` passive/proactive boundary is documented with exact references to `extensions/pi-subagents/src/subagents.ts` and `extensions/pi-subagents/src/agents.ts`.
- Pi extension intervention points are documented with references to `/home/narumi/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
- `third_party/claude-code` patterns are documented for `tools/AgentTool/prompt.ts`, `coordinator/coordinatorMode.ts`, `tools/TeamCreateTool/prompt.ts`, and `tools/AgentTool/runAgent.ts`.
- External sources table includes seven URLs, `accessed 2026-05-17`, summaries, and Pi applicability notes.
- Proactivity levels, decomposition rubric, MVP decision matrix, and bounded L1/L2 spike matrix are included in the research note.
- Follow-up implementation plan created: `docs/plans/2026-05-17_pi-subagents-l1-proactivity-mvp-plan.md`.
- Verification commands run successfully: research-note `rg` checks and `npm run check`.
- Independent `reviewer` subagent returned PASS for the research note, archived plan, follow-up plan, and `npm run check` evidence.

## Risks

- 過度委派會增加 token 成本、等待時間與 UI noise；研究需用「何時不要用 subagent」抵消。
- 自動拆工若碰到可寫入 agent，可能造成同檔案競爭或互相覆蓋；研究需優先建議 read-only fan-out 與 implementation serialization。
- Project-local agents 受 repo 控制；更主動的使用方式不能繞過現有 confirmation 與 trust boundary。
- 動態 agent roster 或長篇 orchestration prompt 可能造成 prompt cache bust 或上下文膨脹；研究需評估靜態 tool metadata 與動態 message injection 的取捨。
- 真正 autonomous scheduler 可能形成自動 follow-up loop；研究需列出停止條件、使用者可見性與 opt-in 設計。

## Completion Checklist

- [x] 目前 `pi-subagents` 的被動/主動邊界已由 exact code references 驗證，evidence lives in `docs/implementation-notes/pi-subagents-proactivity-research.md`.
- [x] `third_party/claude-code` 的相關實作已整理成可移植/不可移植模式表，verified by path references to at least four third-party files in the research note.
- [x] 外部研究與實作搜尋已完成，verified by at least five sourced URLs with accessed dates and Pi applicability notes in the research note.
- [x] Proactivity levels、拆分 rubric、MVP decision matrix 已完成，verified by corresponding tables and at least eight classified example prompts in the research note.
- [x] L1/L2 bounded spike 或明確不做 spike 的理由已記錄，verified by eval matrix plus `npm run check` if code was touched, or by a documented not-applicable rationale.
- [x] 最終 recommendation 已得到使用者接受或形成下一份 implementation plan，verified by explicit user acceptance or a new plan path.
