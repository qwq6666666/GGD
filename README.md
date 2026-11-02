# 生生之境

自主社會演化與歷史生成的輕鬆觀察型建設模擬（Web PWA，手機直式優先）。規格見 [`docs/GDD_v3.1.md`](docs/GDD_v3.1.md)，
規劃建議見 [`docs/planning/v1-plan-review.md`](docs/planning/v1-plan-review.md)，
實作與規格的偏差見 [`docs/planning/stage-review-v1.md`](docs/planning/stage-review-v1.md)。

```sh
pnpm install
pnpm dev                                   # 開啟遊戲
pnpm verify                                # lint + typecheck + test + headless + build
pnpm headless --scenario report --years 20 # 多種子平衡報表
pnpm build && pnpm e2e                     # 真瀏覽器冒煙（手機／桌面尺寸、存檔重載）
```

你是村中領袖，也是有家庭與壽命的居民：回應居民提案、興建公共工程、調整財政，觀察 24 人的聚落如何隨季節、經濟與世代演變。

目前進度：**A0–C1 已實作**（真機效能與真人 playtest 尚未驗收）。開發守則見 [`CLAUDE.md`](CLAUDE.md)。
