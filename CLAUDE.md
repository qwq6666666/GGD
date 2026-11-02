# 生生之境（ShengSheng）— Claude Code 工作守則

自主社會演化的輕鬆觀察型建設模擬（Web PWA，手機直式優先）。
**唯一有效規格：`docs/GDD_v3.1.md`**；依章節拆分的副本在 `docs/spec/`，任務只讀相關章節。

## 指令
- `pnpm install` — 安裝（會設定 `.githooks` 為 git hooks）
- `pnpm lint` / `pnpm typecheck` / `pnpm test`
- `pnpm headless --scenario all --years 10` — 無畫面驗收（growth、replay、speed）
- `pnpm dev` / `pnpm build` — Web 殼
- `pnpm verify` — 合併前完整檢查

## 模組邊界（GDD 11.1）
| 路徑 | 職責 | 可依賴 |
|------|------|--------|
| `packages/sim` | 純模擬核心，Node 可無畫面執行 | content, schema |
| `packages/schema` | Zod 資料契約（命令、存檔） | zod |
| `packages/content` | 所有「待校準」數值與權重表（JSON） | — |
| `packages/persistence` | 存檔序列化、checksum、schema 遷移 | sim, schema |
| `tools/headless` | 批次模擬、驗收情境、平衡報表 | sim, persistence |
| `apps/web` | Worker＋DOM 面板（A3 起加 Phaser） | 全部 |

## 決定性規則（GDD 11.3，ESLint 於 `packages/sim` 強制）
- 禁用 `Math.random/exp/pow/sin/log…`、`Date`、`performance`、`**`、DOM 全域、Map/Set。
- 世界狀態為純 JSON、只含整數（`canonicalize` 會拒絕浮點數）。定點數 `FX=1000`，除法一律用 `fixed.ts` 的 floor。
- 隨機只用世界內的 sfc32 狀態（`prng.ts`）；集合迭代前依 ID 排序；命令依 `(issuedTick, commandId)` 排序。
- 速度、暫停、自動降速只在 Worker 排程層，不進世界狀態（ADR-0002）。
- 每日步進順序固定（GDD 3.1），見 `packages/sim/src/world.ts` 的 `step()`。

## 禁止事項（GDD 16.4）
- 不得為了讓測試通過而修改測試意圖；受保護路徑：`packages/sim/test/determinism.test.ts`、
  `packages/persistence/test/`、`tests/lint/`、`packages/schema/`、PRNG 快照。修改需任務卡授權。
- 不得在程式中寫死「待校準」數值；一律放 `packages/content/src/calibration.json`。
- 未經核准不新增依賴、不跨模組大改、不實作附錄 B（V2）內容。
- 未通過階段門檻不得進入下一階段（GDD 15）。

## 工作流程（GDD 16.3）
1. 讀任務卡（`docs/tasks/`）、相關 `docs/spec/` 章節與 `docs/adr/`，列出將修改的檔案。
2. 先寫／更新測試並請開發者確認意圖。
3. 實作最小切片，跑 `pnpm verify`。
4. 開發者審查 diff；必要時新增 ADR。

## 文件
- `docs/planning/v1-plan-review.md` — 規格審查、待拍板事項、路線
- `docs/adr/` — 架構決策（重新提出已否決方案前必讀）
- `docs/tasks/` — 任務卡
